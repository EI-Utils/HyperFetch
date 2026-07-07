#!/usr/bin/env python3
"""
Chrome Native Messaging host for HyperFetch.
"""

import base64
import json
import os
import struct
import subprocess
import sys
import threading
import time
import uuid
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

BASE_DIR = Path(__file__).resolve().parent.parent
DOWNLOADER_PATH = BASE_DIR / "downloader"


def _detect_browser() -> str:
    """Identify the launching browser from the args it passes to the native host.

    Chrome/Chromium pass the calling extension's origin as argv[1] (e.g.
    "chrome-extension://<id>/"). Firefox passes the app-manifest path as argv[1] and the
    add-on's gecko id (which contains "@", e.g. "hyperfetch@hyperfetch.local") as argv[2].
    This lets Chrome and Firefox — which launch the same host script — keep separate state.
    """
    for arg in sys.argv[1:]:
        if arg.startswith("chrome-extension://") or arg.startswith("chromium-extension://"):
            return "chrome"
    for arg in sys.argv[1:]:
        if "@" in arg:  # Firefox gecko extension id
            return "firefox"
    return "unknown"


BROWSER = _detect_browser()

# Keep download history separate per browser so the Chrome and Firefox extensions (which both
# launch this same host) don't share or clobber each other's history.
HISTORY_FILE = Path(__file__).resolve().parent / f".download_history.{BROWSER}.json"

# Fixed extension ID, derived from the public "key" in chrome-extension/manifest.json.
# Because the ID is stable, this host can register / repair its own manifest on launch,
# so users normally only need to run setup.sh once (or never, after the first launch).
HOST_NAME = "com.hyperfetch.host"
EXTENSION_ID = "ekhohmoicafiheojabajlkkfibppajic"
# Firefox add-on id from firefox-extension/manifest.json (browser_specific_settings.gecko.id).
FIREFOX_EXTENSION_ID = "hyperfetch@hyperfetch.local"

write_lock = threading.Lock()
downloads_lock = threading.Lock()

downloads: Dict[str, "DownloadManager"] = {}

# Browser-streamed downloads (bytes come in via STREAM_CHUNK messages)
stream_downloads: Dict[str, "StreamDownloadManager"] = {}
stream_downloads_lock = threading.Lock()


def _native_host_manifest_dir() -> Path:
    """Return the browser's Native Messaging hosts directory for the current user/OS.

    The location differs per browser: Chrome uses a google-chrome config dir, Firefox uses a
    .mozilla dir. This keeps each browser's self-heal writing only to its own manifest.
    """
    if BROWSER == "firefox":
        if sys.platform == "darwin":
            return (
                Path.home()
                / "Library"
                / "Application Support"
                / "Mozilla"
                / "NativeMessagingHosts"
            )
        return Path.home() / ".mozilla" / "native-messaging-hosts"

    if sys.platform == "darwin":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "Google"
            / "Chrome"
            / "NativeMessagingHosts"
        )

    config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    base = Path(config_home) if config_home else (Path.home() / ".config")
    return base / "google-chrome" / "NativeMessagingHosts"


def _self_heal_manifest() -> None:
    """Ensure this host's manifest exists and points at this script.

    The browser launches this process, so on every launch we can repair the manifest if it
    is missing, points at an old path (e.g. the repo moved), or lost the extension ID.
    This keeps the native host working without re-running setup. Chrome and Firefox use
    different manifest schemas (allowed_origins vs allowed_extensions) and different
    directories, so we only repair the manifest belonging to the browser that launched us.
    Failures are silent: the host must never write to stdout, and a missing manifest simply
    means the very first connection had to be set up manually anyway.
    """
    try:
        host_script = str(Path(__file__).resolve())
        desired = {
            "name": HOST_NAME,
            "description": "Native messaging host for HyperFetch",
            "path": host_script,
            "type": "stdio",
        }
        if BROWSER == "firefox":
            desired["allowed_extensions"] = [FIREFOX_EXTENSION_ID]
        elif BROWSER == "chrome":
            desired["allowed_origins"] = [f"chrome-extension://{EXTENSION_ID}/"]
        else:
            # Unknown launcher — don't guess which manifest to (re)write.
            return

        manifest_dir = _native_host_manifest_dir()
        manifest_path = manifest_dir / f"{HOST_NAME}.json"

        current = None
        if manifest_path.exists():
            try:
                current = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                current = None

        if current == desired:
            return

        manifest_dir.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(desired, indent=2), encoding="utf-8")
    except Exception:
        # Never let self-heal break the host.
        pass



def _redact_command(cmd: list[str]) -> list[str]:
    redacted = list(cmd)
    sensitive_flags = {"--token", "--cookies"}

    for index, part in enumerate(redacted[:-1]):
        if part in sensitive_flags:
            redacted[index + 1] = "<redacted>"

    return redacted


def _send_message(message: dict) -> None:
    encoded = json.dumps(message).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()


def _read_message() -> Optional[dict]:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    if len(raw_length) != 4:
        return None

    message_length = struct.unpack("=I", raw_length)[0]
    payload = sys.stdin.buffer.read(message_length)
    if len(payload) != message_length:
        return None

    return json.loads(payload.decode("utf-8"))


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _safe_filename(name: str) -> str:
    cleaned = str(name or "download.bin").strip().replace("\\", "/")
    return cleaned.split("/")[-1] or "download.bin"


def _default_download_directory() -> Path:
    downloads_dir = Path.home() / "Downloads"
    return downloads_dir if downloads_dir.exists() else Path.home()


def _resolve_initial_directory(initial_dir: Optional[str]) -> Path:
    candidate = str(initial_dir or "").strip()
    if not candidate:
        return _default_download_directory()

    expanded = Path(os.path.expanduser(candidate))
    if expanded.is_dir():
        return expanded

    if expanded.parent.is_dir():
        return expanded.parent

    return _default_download_directory()


def _resolve_output_path(output_dir: str, filename: str) -> Path:
    if output_dir:
        directory = Path(os.path.expanduser(output_dir)).resolve()
    else:
        directory = _default_download_directory()

    directory.mkdir(parents=True, exist_ok=True)
    return directory / _safe_filename(filename)


def _save_history() -> None:
    payload = {}
    with downloads_lock:
        for download_id, manager in downloads.items():
            if manager.progress["status"] in ("completed", "cancelled", "error"):
                payload[download_id] = manager.to_public()

    # Browser-stream downloads (StreamDownloadManager) are tracked separately; persist their
    # finished records too, otherwise no-token Artifactory/SharePoint downloads never appear
    # in history. to_public() exposes the same keys DownloadManager.from_history() expects.
    with stream_downloads_lock:
        for stream in stream_downloads.values():
            public = stream.to_public()
            if public.get("status") in ("completed", "cancelled", "error"):
                payload[public["id"]] = public

    HISTORY_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _cleanup_partial_file(output_path: Path) -> None:
    """
    Remove partial/incomplete download file.
    Handles common scenarios like file locks and permission issues gracefully.
    """
    if not output_path:
        return

    try:
        if output_path.exists():
            output_path.unlink()
            print(f"[MTD] Cleaned up partial file: {output_path}", file=sys.stderr)
    except PermissionError:
        print(f"[MTD] Permission denied while removing partial file: {output_path}", file=sys.stderr)
    except FileNotFoundError:
        # File was already deleted, nothing to do
        pass
    except OSError as e:
        print(f"[MTD] Failed to remove partial file {output_path}: {e}", file=sys.stderr)


def _load_shell_environment() -> None:
    """
    Load environment variables from the user's login shell.
    Chrome native messaging can run with a limited environment.
    """
    # POSIX login shells only; Windows has no equivalent and would error.
    if os.name == "nt":
        return
    try:
        shell = os.environ.get("SHELL", "/bin/bash")
        result = subprocess.run(
            [shell, "-lc", "env"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            for line in result.stdout.split("\n"):
                if "=" in line:
                    key, _, value = line.partition("=")
                    if key:  # Only set if key is not empty
                        os.environ[key] = value
            print(f"[MTD] Loaded shell environment variables", file=sys.stderr)
    except Exception as e:
        print(f"[MTD] Could not load shell environment: {e}", file=sys.stderr)


def _load_history() -> None:
    if not HISTORY_FILE.exists():
        return

    try:
        content = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return

    with downloads_lock:
        for download_id, data in content.items():
            manager = DownloadManager.from_history(download_id, data)
            downloads[download_id] = manager


def _browse_directory(initial_dir: Optional[str] = None) -> dict:
    starting_directory = _resolve_initial_directory(initial_dir)

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:
            pass

        selected = filedialog.askdirectory(
            parent=root,
            title="Select download directory",
            mustexist=True,
            initialdir=str(starting_directory),
        )
        root.destroy()

        if not selected:
            return {"cancelled": True}

        return {"path": str(Path(selected).expanduser().resolve())}
    except Exception as tkinter_error:
        zenity = shutil.which("zenity")
        if zenity:
            initial_filename = str(starting_directory) + os.sep
            result = subprocess.run(
                [zenity, "--file-selection", "--directory", f"--title=Select download directory", f"--filename={initial_filename}"],
                check=False,
                capture_output=True,
                text=True,
            )

            if result.returncode == 0:
                selected = result.stdout.strip()
                if selected:
                    return {"path": str(Path(selected).expanduser().resolve())}

            if result.returncode in (1, 5):
                return {"cancelled": True}

            error_text = result.stderr.strip() or f"zenity exited with code {result.returncode}"
            raise RuntimeError(error_text) from tkinter_error

        raise RuntimeError("Directory picker is unavailable on this system") from tkinter_error


class DownloadManager:
    def __init__(
        self,
        download_id: str,
        url: str,
        output_path: Path,
        threads: int,
        token: Optional[str] = None,
        total_bytes: int = 0,
        cookies: Optional[str] = None,
        referer: Optional[str] = None,
        auth_type: Optional[str] = None,
        user_agent: Optional[str] = None,
    ):
        self.download_id = download_id
        self.url = url
        self.output_path = output_path
        self.filename = output_path.name
        # Use .part extension during download, rename on completion
        self.temp_output_path = Path(str(output_path) + ".part")
        self.threads = max(1, min(int(threads), 32))
        self.token = token.strip() if isinstance(token, str) and token.strip() else None
        self.cookies = cookies.strip() if isinstance(cookies, str) and cookies.strip() else None
        self.referer = referer.strip() if isinstance(referer, str) and referer.strip() else None
        self.auth_type = auth_type.strip() if isinstance(auth_type, str) and auth_type.strip() else None
        self.user_agent = user_agent.strip() if isinstance(user_agent, str) and user_agent.strip() else None
        self.command_preview = ""
        self.process: Optional[subprocess.Popen] = None
        self.started_at = _now_iso()
        self.progress = {
            "status": "pending",
            "progress": 0,
            "totalBytes": int(total_bytes) if total_bytes else 0,
            "speed": 0,
            "eta": 0,
            "error": None,
        }
        self.lock = threading.Lock()

    @classmethod
    def from_history(cls, download_id: str, data: dict) -> "DownloadManager":
        output_path = Path(data.get("outputPath") or (Path.home() / "Downloads" / data.get("filename", "download.bin")))
        manager = cls(
            download_id=download_id,
            url=data.get("url", ""),
            output_path=output_path,
            threads=int(data.get("threads", 8)),
            token=None,
            total_bytes=int(data.get("totalBytes", 0)),
        )
        manager.started_at = data.get("startedAt", _now_iso())
        manager.progress = {
            "status": data.get("status", "completed"),
            "progress": int(data.get("progress", 0)),
            "totalBytes": int(data.get("totalBytes", 0)),
            "speed": int(data.get("speed", 0)),
            "eta": int(data.get("eta", 0)),
            "error": data.get("error"),
        }
        return manager

    def to_public(self) -> dict:
        with self.lock:
            return {
                "id": self.download_id,
                "url": self.url,
                "filename": self.filename,
                "threads": self.threads,
                "status": self.progress["status"],
                "progress": self.progress["progress"],
                "totalBytes": self.progress["totalBytes"],
                "speed": self.progress["speed"],
                "eta": self.progress["eta"],
                "error": self.progress["error"],
                "outputPath": str(self.output_path),
                "startedAt": self.started_at,
            }

    def _emit_update(self) -> None:
        _send_message({"type": "DOWNLOAD_UPDATE", "download": self.to_public()})

    def _build_command(self) -> list[str]:
        cmd = []
        # The downloader is a Python script relying on a shebang line. Windows
        # cannot exec it directly (raises WinError 193), so launch it with the
        # current Python interpreter.
        if os.name == "nt":
            cmd.append(sys.executable)
        cmd += [
            str(DOWNLOADER_PATH),
            self.url,
            "-o",
            str(self.temp_output_path),
            "-t",
            str(self.threads),
            "--json",
            "--skip-url-normalize",
        ]

        if self.token:
            cmd.extend(["--token", self.token])
            if self.auth_type == "bearer":
                cmd.extend(["--token-type", "bearer"])

        if self.cookies:
            cmd.extend(["--cookies", self.cookies])

        if self.referer:
            cmd.extend(["--referer", self.referer])

        if self.user_agent:
            cmd.extend(["--user-agent", self.user_agent])

        return cmd

    def get_command_preview(self) -> str:
        if self.command_preview:
            return self.command_preview
        return " ".join(_redact_command(self._build_command()))

    def start(self) -> None:
        if not DOWNLOADER_PATH.exists():
            raise RuntimeError(f"Downloader binary not found at {DOWNLOADER_PATH}")

        cmd = self._build_command()
        self.command_preview = " ".join(_redact_command(cmd))
        print(f"[MTD] Downloader command: {self.command_preview}", file=sys.stderr)

        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )

        with self.lock:
            self.progress["status"] = "downloading"
            self.progress["error"] = None
        self._emit_update()

        threading.Thread(target=self._monitor, daemon=True).start()

    def _monitor(self) -> None:
        try:
            if self.process and self.process.stdout:
                for line in self.process.stdout:
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    with self.lock:
                        if "downloaded" in data:
                            self.progress["progress"] = int(data["downloaded"])
                        if "total" in data:
                            self.progress["totalBytes"] = int(data["total"])
                        if "speed" in data:
                            self.progress["speed"] = int(data["speed"])
                        if "eta" in data:
                            self.progress["eta"] = int(data["eta"])
                        if "status" in data:
                            self.progress["status"] = str(data["status"])
                        if "error" in data and data["error"]:
                            self.progress["error"] = str(data["error"])

                    self._emit_update()

            if not self.process:
                return

            rc = self.process.wait()

            with self.lock:
                if self.progress["status"] == "cancelled" or rc in (-15, -9):
                    self.progress["status"] = "cancelled"
                    self.progress["speed"] = 0
                    self.progress["eta"] = 0
                    self.progress["error"] = None
                    # Clean up partial file on cancellation
                    _cleanup_partial_file(self.temp_output_path)
                elif rc == 0:
                    if self.progress["totalBytes"] > 0:
                        self.progress["progress"] = self.progress["totalBytes"]
                    self.progress["status"] = "completed"
                    self.progress["speed"] = 0
                    self.progress["eta"] = 0
                    self.progress["error"] = None
                    # Rename from .part to final filename on success
                    try:
                        if self.temp_output_path.exists():
                            self.temp_output_path.rename(self.output_path)
                            print(f"[MTD] Renamed download: {self.temp_output_path.name} → {self.output_path.name}", file=sys.stderr)
                    except Exception as rename_error:
                        print(f"[MTD] Failed to rename {self.temp_output_path} to {self.output_path}: {rename_error}", file=sys.stderr)
                        self.progress["status"] = "error"
                        self.progress["error"] = f"Failed to finalize file: {str(rename_error)}"
                else:
                    err = ""
                    if self.process.stderr:
                        err = self.process.stderr.read().strip()
                    self.progress["status"] = "error"
                    self.progress["error"] = err or f"Process exited with code {rc}"
                    self.progress["speed"] = 0
                    self.progress["eta"] = 0
                    # Clean up partial file on error
                    _cleanup_partial_file(self.temp_output_path)

            self._emit_update()
            _save_history()
        except Exception as exc:
            with self.lock:
                self.progress["status"] = "error"
                self.progress["error"] = str(exc)
                self.progress["speed"] = 0
                self.progress["eta"] = 0
            # Clean up partial file on exception
            _cleanup_partial_file(self.temp_output_path)
            self._emit_update()
            _save_history()

    def cancel(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()

        with self.lock:
            self.progress["status"] = "cancelled"
            self.progress["speed"] = 0
            self.progress["eta"] = 0
            self.progress["error"] = None
        self._emit_update()
        
        # Clean up partial file when download is cancelled
        _cleanup_partial_file(self.temp_output_path)
        
        _save_history()


class StreamDownloadManager:
    """Receives file bytes from the browser extension and writes them to disk."""

    def __init__(
        self,
        stream_id: str,
        download_id: str,
        output_path: Path,
        total_bytes: int,
        threads: int,
        url: str,
    ):
        self.stream_id = stream_id
        self.download_id = download_id
        self.output_path = output_path
        self.temp_output_path = Path(str(output_path) + ".part")
        self.total_bytes = total_bytes
        self.threads = threads
        self.url = url
        self.received = 0
        self.started_at = _now_iso()
        self._file = None
        # Persistent lifecycle status. to_public() must NOT infer status from whether the file
        # handle is open — after cancel()/finalize() close it, an inferred status would report
        # "completed", so a cancelled download would wrongly persist as completed in history.
        self._status = "pending"
        self._lock = threading.Lock()
        # Rolling samples of (monotonic_time, received) for speed/ETA estimation.
        self._samples: list[tuple[float, int]] = []
        self._speed = 0
        self._eta = 0

    def _update_speed(self) -> None:
        """Recompute speed (bytes/sec) and ETA (sec) from a rolling ~5s window.

        Caller must hold self._lock.
        """
        now = time.monotonic()
        self._samples.append((now, self.received))
        # Keep only samples within the last 5 seconds (but always keep at least 2).
        window_start = now - 5.0
        while len(self._samples) > 2 and self._samples[0][0] < window_start:
            self._samples.pop(0)

        first_t, first_bytes = self._samples[0]
        elapsed = now - first_t
        if elapsed > 0:
            self._speed = int((self.received - first_bytes) / elapsed)
        if self._speed > 0 and self.total_bytes > 0:
            remaining = max(0, self.total_bytes - self.received)
            self._eta = int(remaining / self._speed)
        else:
            self._eta = 0

    def start(self) -> None:
        self.temp_output_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = open(self.temp_output_path, "w+b")
        if self.total_bytes > 0:
            self._file.truncate(self.total_bytes)
        self._status = "downloading"
        self._emit("downloading")

    def write_chunk(self, data: bytes, offset: int) -> int:
        with self._lock:
            # A cancel/finalize may have closed the file while chunks were still in flight
            # (parallel workers). Ignore late chunks instead of crashing / resurrecting status.
            if self._file is None or self._status != "downloading":
                return self.received
            if offset >= 0:
                self._file.seek(offset)
            self._file.write(data)
            self.received += len(data)
            self._update_speed()
            return self.received

    def finalize(self) -> None:
        with self._lock:
            if self._file:
                self._file.close()
                self._file = None
            self._status = "completed"
        if self.temp_output_path.exists():
            self.temp_output_path.rename(self.output_path)
        self._emit("completed")

    def cancel(self) -> None:
        with self._lock:
            if self._file:
                self._file.close()
                self._file = None
            self._status = "cancelled"
        _cleanup_partial_file(self.temp_output_path)
        self._emit("cancelled")

    def _emit(self, status: str) -> None:
        _send_message({"type": "DOWNLOAD_UPDATE", "download": self.to_public(status)})

    def to_public(self, status: Optional[str] = None) -> dict:
        with self._lock:
            st = status or self._status
            done = st in ("completed", "cancelled", "error")
            return {
                "id": self.download_id,
                "url": self.url,
                "filename": self.output_path.name,
                "threads": self.threads,
                "status": st,
                "progress": self.received,
                "totalBytes": self.total_bytes,
                "speed": 0 if done else self._speed,
                "eta": 0 if done else self._eta,
                "error": None,
                "outputPath": str(self.output_path),
                "startedAt": self.started_at,
            }


def _handle_request(request: dict) -> dict:
    request_type = request.get("type")
    payload = request.get("payload") or {}

    if request_type == "PING":
        return {"version": "1.1.0-native"}

    if request_type == "START_DOWNLOAD":
        url = str(payload.get("url") or "").strip()
        if not url:
            raise RuntimeError("Missing download URL")

        threads = int(payload.get("threads") or 8)
        filename = _safe_filename(str(payload.get("filename") or "download.bin"))
        output_path = _resolve_output_path(str(payload.get("outputDir") or "").strip(), filename)
        total_bytes = int(payload.get("totalBytes") or 0)
        cookies = str(payload.get("cookies") or "").strip() or None
        referer = str(payload.get("referrer") or "").strip() or None
        auth_type = str(payload.get("authType") or "api-key").strip() or "api-key"
        user_agent = str(payload.get("userAgent") or "").strip() or None

        download_id = str(uuid.uuid4())
        manager = DownloadManager(
            download_id=download_id,
            url=url,
            output_path=output_path,
            threads=threads,
            token=payload.get("token"),
            total_bytes=total_bytes,
            cookies=cookies,
            referer=referer,
            auth_type=auth_type,
            user_agent=user_agent,
        )

        with downloads_lock:
            downloads[download_id] = manager

        manager.start()
        return {
            "downloadId": download_id,
            "commandPreview": manager.get_command_preview(),
        }

    if request_type == "START_STREAM":
        stream_id = str(uuid.uuid4())
        download_id = str(payload.get("downloadId") or stream_id)
        filename = _safe_filename(str(payload.get("filename") or "download.bin"))
        output_path = _resolve_output_path(str(payload.get("outputDir") or "").strip(), filename)
        total_bytes = int(payload.get("totalBytes") or 0)
        threads = int(payload.get("threads") or 1)
        url = str(payload.get("url") or "")

        manager = StreamDownloadManager(
            stream_id=stream_id,
            download_id=download_id,
            output_path=output_path,
            total_bytes=total_bytes,
            threads=threads,
            url=url,
        )
        manager.start()

        with stream_downloads_lock:
            stream_downloads[stream_id] = manager

        print(f"[MTD] Browser stream started: {stream_id} → {output_path.name}", file=sys.stderr)
        return {"streamId": stream_id, "downloadId": download_id}

    if request_type == "STREAM_CHUNK":
        stream_id = str(payload.get("streamId") or "").strip()
        chunk_b64 = str(payload.get("data") or "")
        offset = int(payload.get("offset") if payload.get("offset") is not None else -1)

        with stream_downloads_lock:
            manager = stream_downloads.get(stream_id)

        if not manager:
            raise RuntimeError(f"Stream not found: {stream_id}")

        data = base64.b64decode(chunk_b64)
        received = manager.write_chunk(data, offset)
        # Don't re-emit "downloading" once the stream has been cancelled/finalized (late chunks).
        if manager._status == "downloading":
            manager._emit("downloading")
        return {"received": len(data), "totalReceived": received}

    if request_type == "END_STREAM":
        stream_id = str(payload.get("streamId") or "").strip()

        with stream_downloads_lock:
            manager = stream_downloads.get(stream_id)

        if not manager:
            raise RuntimeError(f"Stream not found: {stream_id}")

        manager.finalize()
        # Keep the finished manager in stream_downloads so it stays visible in LIST_DOWNLOADS
        # and gets persisted by _save_history() (it reports status "completed" once finalized).
        _save_history()
        print(f"[MTD] Browser stream complete: {manager.output_path.name}", file=sys.stderr)
        return {"status": "completed", "outputPath": str(manager.output_path)}

    if request_type == "CANCEL_STREAM":
        stream_id = str(payload.get("streamId") or "").strip()

        with stream_downloads_lock:
            manager = stream_downloads.get(stream_id)

        if manager:
            manager.cancel()
            _save_history()

        return {"cancelled": True}

    if request_type == "LIST_DOWNLOADS":
        with downloads_lock:
            items = [manager.to_public() for manager in downloads.values()]

        with stream_downloads_lock:
            items += [m.to_public() for m in stream_downloads.values()]

        items.sort(key=lambda item: item.get("startedAt", ""), reverse=True)
        return {"downloads": items}

    if request_type == "CANCEL_DOWNLOAD":
        download_id = str(payload.get("downloadId") or "").strip()
        if not download_id:
            raise RuntimeError("Missing downloadId")

        with downloads_lock:
            manager = downloads.get(download_id)

        if manager:
            manager.cancel()
            return {"status": "cancelled"}

        # Browser-streamed downloads are keyed by stream_id but share the extension's
        # download_id; find and cancel any matching stream.
        with stream_downloads_lock:
            stream_manager = None
            stream_key = None
            for key, sm in stream_downloads.items():
                if sm.download_id == download_id:
                    stream_manager = sm
                    stream_key = key
                    break
            if stream_key is not None:
                stream_downloads.pop(stream_key, None)

        if stream_manager:
            stream_manager.cancel()
            return {"status": "cancelled"}

        raise RuntimeError("Download not found")

    if request_type == "OPEN_DOWNLOAD_DIRECTORY":
        download_id = str(payload.get("downloadId") or "").strip()
        if not download_id:
            raise RuntimeError("Missing downloadId")

        with downloads_lock:
            manager = downloads.get(download_id)

        output_path = manager.output_path if manager else None

        # Browser-stream downloads live in stream_downloads (keyed by stream_id), so search
        # by download_id there too — otherwise "open location" fails for no-token Artifactory/
        # SharePoint downloads.
        if output_path is None:
            with stream_downloads_lock:
                for sm in stream_downloads.values():
                    if sm.download_id == download_id:
                        output_path = sm.output_path
                        break

        if output_path is None:
            raise RuntimeError("Download not found")

        directory = output_path.parent
        if os.name == "nt":
            os.startfile(str(directory))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(directory)])
        else:
            subprocess.Popen(["xdg-open", str(directory)])
        return {"opened": True}

    if request_type == "CLEAR_HISTORY":
        removed_count = 0
        with downloads_lock:
            to_remove = [
                download_id
                for download_id, manager in downloads.items()
                if manager.to_public().get("status") in ("completed", "cancelled", "error")
            ]
            for download_id in to_remove:
                downloads.pop(download_id, None)
                removed_count += 1

        if HISTORY_FILE.exists():
            HISTORY_FILE.unlink(missing_ok=True)

        return {"removed_count": removed_count}

    if request_type == "BROWSE_DIRECTORY":
        return _browse_directory(payload.get("downloadDir"))

    if request_type == "CHECK_FILE_EXISTS":
        filename = str(payload.get("filename") or "").strip()
        download_dir = str(payload.get("downloadDir") or "").strip()
        if not filename:
            raise RuntimeError("Missing filename")
        if not download_dir:
            raise RuntimeError("Missing downloadDir")

        file_path = Path(os.path.expanduser(download_dir)) / filename
        exists = file_path.exists()
        return {"exists": exists}

    if request_type == "GET_NEXT_FILENAME":
        filename = str(payload.get("filename") or "").strip()
        download_dir = str(payload.get("downloadDir") or "").strip()
        if not filename:
            raise RuntimeError("Missing filename")
        if not download_dir:
            raise RuntimeError("Missing downloadDir")

        directory = Path(os.path.expanduser(download_dir))
        if not directory.is_dir():
            return {"nextFilename": filename}

        # Check if file exists
        file_path = directory / filename
        if not file_path.exists():
            return {"nextFilename": filename}

        # Split filename and extension
        name_parts = filename.rsplit(".", 1)
        if len(name_parts) == 2:
            base_name, ext = name_parts
            ext = "." + ext
        else:
            base_name = filename
            ext = ""

        # Find next available number
        counter = 1
        while counter <= 9999:
            next_filename = f"{base_name} ({counter}){ext}"
            next_path = directory / next_filename
            if not next_path.exists():
                return {"nextFilename": next_filename}
            counter += 1

        raise RuntimeError("Could not generate available filename")

    raise RuntimeError(f"Unsupported request type: {request_type}")


def main() -> None:
    _self_heal_manifest()
    _load_shell_environment()
    _load_history()

    while True:
        request = _read_message()
        if request is None:
            break

        request_id = request.get("requestId")
        if not request_id:
            continue

        try:
            result = _handle_request(request)
            _send_message({
                "type": "RESPONSE",
                "requestId": request_id,
                "ok": True,
                "result": result,
            })
        except Exception as exc:
            _send_message({
                "type": "RESPONSE",
                "requestId": request_id,
                "ok": False,
                "error": str(exc),
            })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Native host must not print arbitrary output to stdout.
        time.sleep(0.1)
