console.log('[MTD] Background script loaded');

const CONFIG = {
  MIN_FILE_SIZE: 100 * 1024 * 1024,
  NATIVE_HOST: 'com.hyperfetch.host'
};

const EXCLUDED_SITE_DEFAULTS = [];

const interceptedDownloads = new Map();
const earlyInterceptedIds = new Set();
const interceptWindowIds = new Map();
const nativeBypassDownloadIds = new Set();
const nativeBypassUrls = new Map();

// Active browser-stream downloads: downloadId (string) -> { streamId, controller }.
// Used to cancel an in-flight stream (abort its fetches + tell the native host to clean up).
const activeStreamDownloads = new Map();

// Artifactory auth tokens captured from browser requests: hostname -> { type, value, capturedAt }
let capturedArtifactoryAuth = {};

// XDM-style capture of the browser's real request headers for SharePoint downloads.
// SharePoint's FedAuth session cookie is SameSite-restricted, so it is only attached by the
// browser to its own genuine navigation download — never to an extension fetch(). But
// webRequest.onBeforeSendHeaders (with 'extraHeaders') lets us OBSERVE that exact outgoing
// request, including the full Cookie header the browser already decided to send. We capture it
// and replay it verbatim from the native downloader: a raw HTTP client is not bound by the
// browser's SameSite policy, so the cookie authenticates and the download can be multithreaded.
const CAPTURED_HEADERS_MAX_AGE_MS = 3_600_000; // 1h
const capturedSharePointReferer = new Map(); // download URL -> { referer, capturedAt }
// Per-host UNION of every cookie the browser has attached to any SharePoint request, keyed by
// cookie name (latest value wins). Individual requests carry different subsets of the jar
// (one request may omit FedAuth, another includes it), so unioning them reconstructs the full
// authenticated cookie set — including the httpOnly FedAuth needed for document downloads.
const capturedSharePointCookies = new Map(); // hostname -> { cookies: Map(name->value), userAgent, capturedAt }

function parseCookieHeader(cookieHeader) {
  const out = [];
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
  }
  return out;
}

function rememberSharePointHeaders(url, hostname, details) {
  let cookieHeader = '';
  let userAgent = '';
  let referer = '';
  for (const header of (details.requestHeaders || [])) {
    const name = header.name.toLowerCase();
    if (name === 'cookie') cookieHeader = header.value || '';
    else if (name === 'user-agent') userAgent = header.value || '';
    else if (name === 'referer') referer = header.value || '';
  }
  if (!cookieHeader) return;

  const now = Date.now();
  let entry = capturedSharePointCookies.get(hostname);
  if (!entry) {
    entry = { cookies: new Map(), userAgent: '', capturedAt: now };
    capturedSharePointCookies.set(hostname, entry);
  }
  for (const [name, value] of parseCookieHeader(cookieHeader)) {
    entry.cookies.set(name, value);
  }
  if (userAgent) entry.userAgent = userAgent;
  entry.capturedAt = now;

  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = ''; }
  if (path.includes('/download.aspx') || path.startsWith('/:')) {
    if (referer) capturedSharePointReferer.set(url, { referer, capturedAt: now });
    console.log('[MTD] Captured SharePoint session cookies:', Array.from(entry.cookies.keys()).join(', '));
  }
}

// Return the freshest merged browser headers for a SharePoint download: the per-host cookie
// union plus a per-URL Referer if one was observed. `extraCookies` (from chrome.cookies.getAll)
// are merged in as well so httpOnly cookies visible only to the cookies API are not lost.
function getCapturedSharePointHeaders(url, hostname, extraCookies) {
  const now = Date.now();
  const entry = capturedSharePointCookies.get(hostname);
  const merged = new Map();
  if (entry && (now - entry.capturedAt) < CAPTURED_HEADERS_MAX_AGE_MS) {
    for (const [name, value] of entry.cookies) merged.set(name, value);
  }
  for (const [name, value] of (extraCookies || [])) {
    if (name && value != null) merged.set(name, value);
  }
  if (merged.size === 0) return null;

  // SharePoint/IIS rejects an oversized Cookie header (~8 KB limit). Send only the auth-relevant
  // cookies so analytics/SPA/MSAL cookies don't push the request past that limit. Keep the full
  // set only if none of the known auth cookies are present (so we never send an empty auth jar).
  const AUTH_NAMES = new Set(['fedauth', 'rtfa', 'simi', 'oidcauth']);
  const authEntries = Array.from(merged.entries()).filter(([n]) => {
    const lower = n.toLowerCase();
    return AUTH_NAMES.has(lower) || lower.startsWith('sig1.');
  });
  const finalEntries = authEntries.length > 0 ? authEntries : Array.from(merged.entries());

  const refEntry = capturedSharePointReferer.get(url);
  const referer = (refEntry && (now - refEntry.capturedAt) < CAPTURED_HEADERS_MAX_AGE_MS)
    ? refEntry.referer : '';
  const cookie = finalEntries.map(([n, v]) => `${n}=${v}`).join('; ');
  return { cookie, userAgent: entry?.userAgent || '', referer, cookieNames: finalEntries.map(([n]) => n) };
}

const runtimeSettings = {
  autoIntercept: true,
  minFileSizeBytes: CONFIG.MIN_FILE_SIZE,
  excludedHosts: new Set()
};

let nativePort = null;
let nativeReconnectTimer = null;
let requestCounter = 0;
const pendingNativeRequests = new Map();

function normalizeExcludedHost(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const withScheme = raw.includes('://') ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withScheme);
    if (!parsed.host) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function sanitizeExcludedHosts(input) {
  const list = Array.isArray(input) ? input : [];
  const normalized = list
    .map((entry) => normalizeExcludedHost(entry))
    .filter((entry) => Boolean(entry));

  return Array.from(new Set(normalized));
}

async function refreshRuntimeSettings() {
  try {
    const settings = await chrome.storage.sync.get({
      autoIntercept: true,
      minFileSize: 100,
      excludedSites: EXCLUDED_SITE_DEFAULTS
    });

    runtimeSettings.autoIntercept = settings.autoIntercept !== false;

    const minFileSizeMb = Number(settings.minFileSize);
    runtimeSettings.minFileSizeBytes = Number.isFinite(minFileSizeMb) && minFileSizeMb > 0
      ? minFileSizeMb * 1024 * 1024
      : CONFIG.MIN_FILE_SIZE;

    runtimeSettings.excludedHosts = new Set(sanitizeExcludedHosts(settings.excludedSites));
    console.log('[MTD] Runtime interception settings refreshed', {
      autoIntercept: runtimeSettings.autoIntercept,
      minFileSizeBytes: runtimeSettings.minFileSizeBytes,
      excludedHosts: Array.from(runtimeSettings.excludedHosts)
    });
  } catch (error) {
    console.error('[MTD] Failed to refresh runtime settings:', error);
  }
}

function isExcludedDownloadUrl(url) {
  try {
    const host = new URL(url || '').host.toLowerCase();
    return runtimeSettings.excludedHosts.has(host);
  } catch {
    return false;
  }
}

// SharePoint/OneDrive downloads are accelerated via the XDM-style captured-header replay path
// (see the capturedSharePointHeaders notes above and the SharePoint branch in startDownload).
function resolveFilename(downloadItem) {
  if (downloadItem.filename) {
    const parts = downloadItem.filename.split('/');
    return parts[parts.length - 1] || 'download.bin';
  }

  try {
    const parsed = new URL(downloadItem.url || '');

    const queryPath = parsed.searchParams.get('path');
    if (queryPath) {
      let decodedPath = queryPath;
      for (let i = 0; i < 3; i += 1) {
        const next = decodeURIComponent(decodedPath);
        if (next === decodedPath) break;
        decodedPath = next;
      }
      const queryTail = decodedPath.split('/').pop();
      if (queryTail) {
        return queryTail;
      }
    }

    // SharePoint download.aspx — extract filename from FileName or file param
    if (parsed.pathname.includes('/download.aspx')) {
      const spFilename = parsed.searchParams.get('FileName') || parsed.searchParams.get('filename');
      if (spFilename) {
        return spFilename.split('/').pop() || 'download.bin';
      }
    }

    // SharePoint sharing URL — extract filename from the path after /:u:/r/
    const sharingMatch = parsed.pathname.match(/^\/:u:\/r\/(.*)/);
    if (sharingMatch) {
      const tail = decodeURIComponent(sharingMatch[1]).split('/').pop();
      if (tail) return tail;
    }

    const pathPart = parsed.pathname.split('/').pop();
    return pathPart || 'download.bin';
  } catch {
    return 'download.bin';
  }
}

function hostnameSubdir(url) {
  try {
    const host = new URL(url || '').hostname.toLowerCase().trim();
    // hostname is already restricted, but strip anything unsafe for a path segment
    return host.replace(/[^a-z0-9._-]/g, '');
  } catch {
    return '';
  }
}

function appendDomainSubdir(baseDir, url) {
  const host = hostnameSubdir(url);
  if (!baseDir || !host) {
    return baseDir;
  }

  const trimmed = baseDir.replace(/[\\/]+$/, '');
  const suffix = `/${host}`;
  // Avoid double-appending if the domain subdir is already present
  if (trimmed.toLowerCase().endsWith(suffix)) {
    return trimmed;
  }

  return `${trimmed}${suffix}`;
}

function shouldInterceptDownload(filename, totalBytes, minFileSizeBytes) {
  const lowerName = (filename || '').toLowerCase();
  const largeExts = ['.zip', '.tar', '.tar.gz', '.tgz', '.iso', '.exe', '.dmg', '.apk', '.bin', '.img'];
  const isLargeFileType = largeExts.some((ext) => lowerName.endsWith(ext));
  return (totalBytes > minFileSizeBytes) || (isLargeFileType && totalBytes === 0);
}

function shouldInterceptDownloadItem(downloadItem) {
  if (nativeBypassDownloadIds.has(downloadItem.id)) {
    nativeBypassDownloadIds.delete(downloadItem.id);
    return false;
  }

  if (consumeNativeBypassUrl(downloadItem.url)) {
    return false;
  }

  if (!runtimeSettings.autoIntercept) {
    return false;
  }

  if (isExcludedDownloadUrl(downloadItem.url)) {
    return false;
  }

  const filename = resolveFilename(downloadItem);
  const totalBytes = downloadItem.totalBytes || 0;
  return shouldInterceptDownload(filename, totalBytes, runtimeSettings.minFileSizeBytes);
}

function markNativeBypassUrl(url) {
  const key = String(url || '').trim();
  if (!key) {
    return;
  }

  const existingTimer = nativeBypassUrls.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    nativeBypassUrls.delete(key);
  }, 30000);

  nativeBypassUrls.set(key, timer);
}

function consumeNativeBypassUrl(url) {
  const key = String(url || '').trim();
  if (!key) {
    return false;
  }

  const timer = nativeBypassUrls.get(key);
  if (!timer) {
    return false;
  }

  clearTimeout(timer);
  nativeBypassUrls.delete(key);
  return true;
}

async function openInterceptWindow(downloadId) {
  const existingWindowId = interceptWindowIds.get(downloadId);
  if (existingWindowId) {
    try {
      await chrome.windows.update(existingWindowId, { focused: true });
      return;
    } catch {
      interceptWindowIds.delete(downloadId);
    }
  }

  const popupUrl = chrome.runtime.getURL(`src/intercept.html?downloadId=${downloadId}`);
  const created = await chrome.windows.create({
    url: popupUrl,
    type: 'popup',
    width: 560,
    height: 560,
    focused: true
  });

  if (typeof created.id === 'number') {
    interceptWindowIds.set(downloadId, created.id);
  }
}

function closeInterceptWindow(downloadId) {
  const windowId = interceptWindowIds.get(Number(downloadId));
  if (typeof windowId !== 'number') {
    return;
  }

  chrome.windows.remove(windowId).catch(() => {});
  interceptWindowIds.delete(Number(downloadId));
}

async function getInterceptedDownload(downloadId) {
  const settings = await getSettings();
  const download = interceptedDownloads.get(Number(downloadId));
  if (!download) {
    return null;
  }

  let downloadDir = download.downloadDir || settings.downloadDir || '';
  if (settings.createSubdir) {
    downloadDir = appendDomainSubdir(downloadDir, download.url);
  }

  return {
    id: String(downloadId),
    filename: download.filename || 'download.bin',
    totalBytes: download.totalBytes || 0,
    downloadDir,
    threadCount: settings.threadCount || 8
  };
}

function interceptBrowserDownload(downloadItem) {
  const id = downloadItem.id;
  const filename = resolveFilename(downloadItem);
  const totalBytes = downloadItem.totalBytes || 0;

  if (!shouldInterceptDownloadItem(downloadItem)) {
    return false;
  }

  if (interceptedDownloads.has(id)) {
    return true;
  }

  console.log('[MTD] Intercepting:', filename);

  chrome.downloads.cancel(id, () => {
    console.log('[MTD] Cancelled browser download:', id);
  });

  interceptedDownloads.set(id, {
    url: downloadItem.url,
    referrer: downloadItem.referrer || '',
    filename,
    totalBytes
  });

  openInterceptWindow(id).catch((error) => {
    console.error('[MTD] Failed to open intercept window:', error);
  });

  return true;
}

async function getSettings() {
  return chrome.storage.sync.get({
    threadCount: 8,
    minFileSize: 100,
    autoIntercept: true,
    excludedSites: EXCLUDED_SITE_DEFAULTS,
    downloadDir: '',
    createSubdir: false,
    authToken: '',
    authType: 'api-key'
  });
}

function scheduleNativeReconnect() {
  if (nativeReconnectTimer) {
    return;
  }

  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null;
    connectNativeHost();
  }, 1500);
}

function rejectPendingRequests(errorMessage) {
  for (const [, pending] of pendingNativeRequests.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(errorMessage));
  }
  pendingNativeRequests.clear();
}

function handleNativeMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'RESPONSE') {
    const requestId = message.requestId;
    const pending = pendingNativeRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    pendingNativeRequests.delete(requestId);

    if (message.ok) {
      pending.resolve(message.result || {});
      return;
    }

    pending.reject(new Error(message.error || 'Native host request failed'));
    return;
  }

  if (message.type === 'DOWNLOAD_UPDATE') {
    const dl = message.download;
    if (dl.status === 'error') {
      console.error('[MTD] Download failed:', dl.id, '|', dl.error);
    }
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS_UPDATE', download: dl }).catch(() => {});
  }
}

function connectNativeHost() {
  if (nativePort) {
    return nativePort;
  }

  try {
    nativePort = chrome.runtime.connectNative(CONFIG.NATIVE_HOST);

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      const errMsg = chrome.runtime.lastError?.message || 'Native host disconnected';
      console.error('[MTD] Native host disconnected:', errMsg);
      nativePort = null;
      rejectPendingRequests(errMsg);
      scheduleNativeReconnect();
    });

    console.log('[MTD] Connected to native host:', CONFIG.NATIVE_HOST);
  } catch (error) {
    console.error('[MTD] Failed to connect native host:', error);
    nativePort = null;
    scheduleNativeReconnect();
  }

  return nativePort;
}

function sendNativeRequest(type, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const port = connectNativeHost();
    if (!port) {
      reject(new Error('Native host is not available. Install and register the native host first.'));
      return;
    }

    requestCounter += 1;
    const requestId = `req-${Date.now()}-${requestCounter}`;

    const timer = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`Native host request timeout for ${type}`));
    }, timeoutMs);

    pendingNativeRequests.set(requestId, {
      resolve,
      reject,
      timer
    });

    try {
      port.postMessage({
        type,
        payload,
        requestId
      });
    } catch (error) {
      clearTimeout(timer);
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

async function fetchNativeDownloads() {
  const data = await sendNativeRequest('LIST_DOWNLOADS');
  const list = Array.isArray(data.downloads) ? data.downloads : [];
  const now = new Date().toISOString();

  const interceptedList = Array.from(interceptedDownloads.entries()).map(([id, dl]) => ({
    id: String(id),
    filename: dl.filename || 'download.bin',
    status: 'intercepted',
    progress: 0,
    totalBytes: dl.totalBytes || 0,
    speed: 0,
    eta: 0,
    error: null,
    outputPath: '',
    downloadDir: dl.downloadDir || '',
    startedAt: now
  }));

  const activeList = list.map((dl) => ({
    id: dl.id,
    filename: dl.filename || 'download.bin',
    status: dl.status || 'pending',
    progress: Number(dl.progress) || 0,
    totalBytes: Number(dl.totalBytes) || 0,
    speed: Number(dl.speed) || 0,
    eta: Number(dl.eta) || 0,
    error: dl.error || null,
    outputPath: dl.outputPath || '',
    startedAt: dl.startedAt || now
  }));

  const combined = [...interceptedList, ...activeList];
  combined.sort((a, b) => {
    const timeA = new Date(a.startedAt).getTime();
    const timeB = new Date(b.startedAt).getTime();
    return timeB - timeA;
  });

  return combined;
}

function cancelNativeDownload(downloadId) {
  return sendNativeRequest('CANCEL_DOWNLOAD', { downloadId: String(downloadId) });
}

function openDownloadDirectory(downloadId) {
  return sendNativeRequest('OPEN_DOWNLOAD_DIRECTORY', { downloadId: String(downloadId) });
}

function browseDirectory(payload = {}) {
  return sendNativeRequest('BROWSE_DIRECTORY', payload);
}

function checkFileExists(filename, downloadDir) {
  return sendNativeRequest('CHECK_FILE_EXISTS', { filename, downloadDir });
}

function getNextFilename(filename, downloadDir) {
  return sendNativeRequest('GET_NEXT_FILENAME', { filename, downloadDir });
}

function clearDownloadHistory() {
  return sendNativeRequest('CLEAR_HISTORY', {});
}

function dismissInterceptedDownload(downloadId) {
  interceptedDownloads.delete(Number(downloadId));
  closeInterceptWindow(downloadId);
}

async function addWebsiteToExcludedSites(url) {
  const host = normalizeExcludedHost(url);
  if (!host) {
    return false;
  }

  const settings = await chrome.storage.sync.get({
    excludedSites: EXCLUDED_SITE_DEFAULTS
  });

  const currentSites = Array.isArray(settings.excludedSites) ? settings.excludedSites : [];
  const currentHosts = new Set(sanitizeExcludedHosts(currentSites));
  if (currentHosts.has(host)) {
    return false;
  }

  let protocol = 'https:';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      protocol = parsed.protocol;
    }
  } catch {
    // Keep the default protocol for storage formatting.
  }

  const updatedSites = [...currentSites, `${protocol}//${host}/`];
  await chrome.storage.sync.set({ excludedSites: updatedSites });
  runtimeSettings.excludedHosts = new Set(sanitizeExcludedHosts(updatedSites));
  return true;
}

function triggerBrowserDownload(downloadInfo) {
  return new Promise((resolve, reject) => {
    const options = {
      url: downloadInfo.url
    };

    if (downloadInfo.filename) {
      // Save with the (possibly user-edited) filename. chrome.downloads only allows a path
      // relative to the browser's Downloads folder, so use just the basename.
      const base = String(downloadInfo.filename).split(/[\\/]/).pop();
      if (base) {
        options.filename = base;
      }
    }

    if (downloadInfo.referrer) {
      options.headers = [{ name: 'Referer', value: downloadInfo.referrer }];
    }

    chrome.downloads.download(options, (id) => {
      if (chrome.runtime.lastError || typeof id !== 'number') {
        reject(new Error(chrome.runtime.lastError?.message || 'Failed to start browser download'));
        return;
      }

      resolve(id);
    });
  });
}

async function startNativeBrowserDownload(downloadId, downloadInfo) {
  if (!downloadInfo || !downloadInfo.url) {
    throw new Error('Intercepted download URL is missing');
  }

  // Use the JFrog UI download endpoint (cookie-authenticated). The `/artifactory/` REST
  // path returns 401 without a token, even in the browser's native download stack.
  const resolvedUrl = resolveArtifactoryStreamUrl(downloadInfo.url);
  if (resolvedUrl !== downloadInfo.url) {
    console.log('[MTD] Browser fallback using Artifactory URL:', resolvedUrl);
  }

  markNativeBypassUrl(resolvedUrl);

  let browserDownloadId;
  try {
    browserDownloadId = await triggerBrowserDownload({
      ...downloadInfo,
      url: resolvedUrl
    });
  } catch (error) {
    if (downloadInfo.referrer) {
      // Some environments reject custom headers for downloads; retry without referer.
      browserDownloadId = await triggerBrowserDownload({
        url: resolvedUrl,
        filename: downloadInfo.filename,
        referrer: ''
      });
    } else {
      throw error;
    }
  }

  nativeBypassDownloadIds.add(browserDownloadId);
  dismissInterceptedDownload(downloadId);

  return browserDownloadId;
}

function setupArtifactoryTokenCapture() {
  if (!chrome.webRequest || !chrome.webRequest.onBeforeSendHeaders) {
    console.warn('[MTD] webRequest API unavailable; Artifactory token capture disabled');
    return;
  }

  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const hostname = new URL(details.url).hostname.toLowerCase();

        // XDM-style: capture the browser's real Cookie/User-Agent/Referer for SharePoint so the
        // native downloader can replay the SameSite-restricted FedAuth cookie (see notes above).
        if (hostname.endsWith('.sharepoint.com')) {
          rememberSharePointHeaders(details.url, hostname, details);
          return;
        }

        if (!hostname.includes('artifactory')) return;

        for (const header of (details.requestHeaders || [])) {
          const name = header.name.toLowerCase();
          const val = header.value || '';

          if (name === 'x-jfrog-art-api' && val) {
            capturedArtifactoryAuth[hostname] = { type: 'api_key', value: val, capturedAt: Date.now() };
            chrome.storage.session.set({ capturedArtifactoryAuth }).catch(() => {});
            console.log('[MTD] Captured X-JFrog-Art-Api token for', hostname);
            break;
          }
          if (name === 'authorization' && val.toLowerCase().startsWith('bearer ') && val.length > 7) {
            capturedArtifactoryAuth[hostname] = { type: 'bearer', value: val.substring(7), capturedAt: Date.now() };
            chrome.storage.session.set({ capturedArtifactoryAuth }).catch(() => {});
            console.log('[MTD] Captured Bearer token for', hostname);
            break;
          }
        }
      } catch {}
    },
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
  );

  console.log('[MTD] Request header capture listener registered (Artifactory tokens + SharePoint session)');
}

function setupListeners() {
  console.log('[MTD] Setting up listeners');

  try {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
      try {
        if (shouldInterceptDownloadItem(downloadItem)) {
          earlyInterceptedIds.add(downloadItem.id);
          chrome.downloads.cancel(downloadItem.id, () => {
            console.log('[MTD] Early-cancelled download during filename determination:', downloadItem.id);
          });

          const stored = interceptedDownloads.get(downloadItem.id);
          if (stored) {
            // Already intercepted from onCreated with a wrong URL-derived filename.
            // Replace it with the real filename from the Content-Disposition header.
            if (downloadItem.filename) {
              const resolvedName = downloadItem.filename.split('/').pop();
              if (resolvedName && resolvedName !== stored.filename) {
                console.log('[MTD] Correcting filename:', stored.filename, '->', resolvedName);
                stored.filename = resolvedName;
              }
            }
            // Capture the referrer (original sharing URL with e= token) if not yet stored.
            if (!stored.referrer && downloadItem.referrer) {
              stored.referrer = downloadItem.referrer;
            }
          } else {
            // onCreated did not intercept this download (e.g. URL path was "download.aspx"
            // with unknown size so shouldInterceptDownload returned false). Now that we have
            // the real filename from Content-Disposition, intercept it here.
            const filename = resolveFilename(downloadItem);
            console.log('[MTD] Late-intercepting:', filename);
            interceptedDownloads.set(downloadItem.id, {
              url: downloadItem.url,
              referrer: downloadItem.referrer || '',
              filename,
              totalBytes: downloadItem.totalBytes || 0
            });
            openInterceptWindow(downloadItem.id).catch((error) => {
              console.error('[MTD] Failed to open intercept window (late):', error);
            });
          }
        }
      } catch (e) {
        console.error('[MTD] onDeterminingFilename interception error:', e);
      } finally {
        suggest();
      }
    });
    console.log('[MTD] Filename determination listener added');
  } catch (e) {
    console.error('[MTD] Failed to add determining filename listener:', e);
  }

  try {
    chrome.downloads.onCreated.addListener((downloadItem) => {
      console.log('[MTD] Download created:', downloadItem.filename || downloadItem.url || '<unknown>');
      handleDownloadCreated(downloadItem);
    });
    console.log('[MTD] Download created listener added');
  } catch (e) {
    console.error('[MTD] Failed to add download listener:', e);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PING') {
      sendResponse({ status: 'active' });
      return;
    }

    if (request.type === 'GET_DOWNLOADS') {
      fetchNativeDownloads()
        .then((downloads) => sendResponse({ downloads }))
        .catch((error) => {
          console.error('[MTD] GET_DOWNLOADS failed:', error);
          sendResponse({ downloads: [], error: error.message });
        });
      return true;
    }

    if (request.type === 'NATIVE_PING') {
      sendNativeRequest('PING', {})
        .then((result) => sendResponse({ ok: true, version: result.version || 'unknown' }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (request.type === 'GET_INTERCEPTED_DOWNLOAD') {
      getInterceptedDownload(request.downloadId)
        .then((download) => sendResponse({ download }))
        .catch((error) => {
          console.error('[MTD] GET_INTERCEPTED_DOWNLOAD failed:', error);
          sendResponse({ download: null, error: error.message });
        });
      return true;
    }

    if (request.type === 'CANCEL_DOWNLOAD') {
      const streamKey = String(request.downloadId);
      const activeStream = activeStreamDownloads.get(streamKey);
      if (activeStream) {
        // Browser-stream download: abort the in-flight fetches and tell the native host to
        // discard the partial file. The background streaming loop's finally block also cleans
        // up the registry entry.
        activeStream.controller.abort();
        activeStreamDownloads.delete(streamKey);
        interceptedDownloads.delete(Number(request.downloadId));
        sendNativeRequest('CANCEL_STREAM', { streamId: activeStream.streamId })
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            console.error('[MTD] CANCEL_STREAM failed:', error);
            // The fetches are already aborted, so treat the cancel as successful.
            sendResponse({ ok: true });
          });
        return true;
      }

      cancelNativeDownload(request.downloadId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.error('[MTD] CANCEL_DOWNLOAD failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'OPEN_DOWNLOAD_DIRECTORY') {
      openDownloadDirectory(request.downloadId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.error('[MTD] OPEN_DOWNLOAD_DIRECTORY failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'BROWSE_DIRECTORY') {
      browseDirectory({ downloadDir: request.downloadDir })
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error('[MTD] BROWSE_DIRECTORY failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'CHECK_FILE_EXISTS') {
      checkFileExists(request.filename, request.downloadDir)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error('[MTD] CHECK_FILE_EXISTS failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'GET_NEXT_FILENAME') {
      getNextFilename(request.filename, request.downloadDir)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error('[MTD] GET_NEXT_FILENAME failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'CLEAR_HISTORY') {
      clearDownloadHistory()
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error('[MTD] CLEAR_HISTORY failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'START_INTERCEPTED_DOWNLOAD') {
      const download = interceptedDownloads.get(Number(request.downloadId));
      if (!download) {
        sendResponse({ ok: false, error: 'Intercepted download not found' });
        return;
      }

      if (typeof request.downloadDir === 'string') {
        download.downloadDir = request.downloadDir;
      }

      if (request.skipSubdir === true) {
        download.skipSubdir = true;
      }

      if (typeof request.filename === 'string' && request.filename.trim()) {
        download.filename = request.filename.trim();
      }

      startDownload(Number(request.downloadId), download)
        .then(() => {
          closeInterceptWindow(request.downloadId);
          sendResponse({ ok: true });
        })
        .catch(async (error) => {
          console.error('[MTD] START_INTERCEPTED_DOWNLOAD failed:', error);

          // Artifactory often requires browser-managed auth/session context.
          // If native start fails, degrade gracefully by starting a browser download.
          let isArtifactory = false;
          try {
            isArtifactory = new URL(download.url).hostname.toLowerCase().includes('artifactory');
          } catch {
            isArtifactory = false;
          }

          if (isArtifactory) {
            try {
              const browserDownloadId = await startNativeBrowserDownload(Number(request.downloadId), download);
              closeInterceptWindow(request.downloadId);
              console.warn('[MTD] Falling back to browser download for Artifactory:', browserDownloadId);
              sendResponse({
                ok: true,
                browserFallback: true,
                browserDownloadId,
                warning: `Native download failed (${error.message}). Switched to browser download.`
              });
              return;
            } catch (fallbackError) {
              console.error('[MTD] Artifactory browser fallback failed:', fallbackError);
              sendResponse({ ok: false, error: fallbackError.message || error.message });
              return;
            }
          }

          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'USE_NATIVE_DOWNLOAD') {
      const download = interceptedDownloads.get(Number(request.downloadId));
      if (!download) {
        sendResponse({ ok: false, error: 'Intercepted download not found' });
        return;
      }

      const preferNativeForWebsite = request.preferNativeForWebsite === true;

      Promise.resolve()
        .then(async () => {
          let websiteAddedToExcludedSites = false;

          if (preferNativeForWebsite) {
            try {
              websiteAddedToExcludedSites = await addWebsiteToExcludedSites(download.url);
            } catch (error) {
              console.warn('[MTD] Failed to persist website in excluded sites:', error);
            }
          }

          const browserDownloadId = await startNativeBrowserDownload(Number(request.downloadId), download);
          sendResponse({ ok: true, browserDownloadId, websiteAddedToExcludedSites });
        })
        .catch((error) => {
          console.error('[MTD] USE_NATIVE_DOWNLOAD failed:', error);
          sendResponse({ ok: false, error: error.message });
        });
      return true;
    }

    if (request.type === 'DISMISS_INTERCEPTED_DOWNLOAD') {
      dismissInterceptedDownload(request.downloadId);
      sendResponse({ ok: true });
      return;
    }
  });

  console.log('[MTD] All listeners setup complete');
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [downloadId, trackedWindowId] of interceptWindowIds.entries()) {
    if (trackedWindowId === windowId) {
      interceptWindowIds.delete(downloadId);
      break;
    }
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && (changes.autoIntercept || changes.minFileSize || changes.excludedSites)) {
    refreshRuntimeSettings();
  }
});

function handleDownloadCreated(downloadItem) {
  if (!shouldInterceptDownloadItem(downloadItem)) {
    return;
  }

  if (earlyInterceptedIds.has(downloadItem.id)) {
    earlyInterceptedIds.delete(downloadItem.id);
  }

  interceptBrowserDownload(downloadItem);
}

function resolveSharePointUrl(url, referrer) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.toLowerCase().endsWith('.sharepoint.com')) {
      return url;
    }

    // Sharing URL: /:u:/r/{server-relative-path}?...  →  /{server-relative-path}
    const sharingMatch = parsed.pathname.match(/^\/:u:\/r\/(.*)/);
    if (sharingMatch) {
      return `${parsed.origin}/${sharingMatch[1]}`;
    }

    // ASPX download handler
    if (parsed.pathname.includes('/_layouts/15/download.aspx')) {
      // SourceUrl param directly encodes the file path
      const sourceUrl = parsed.searchParams.get('SourceUrl') || parsed.searchParams.get('sourceurl');
      if (sourceUrl) {
        return `${parsed.origin}${sourceUrl}`;
      }

      // Reconstruct the direct file URL from the referrer (the SharePoint sharing page).
      // The referrer is typically /:u:/r/sites/.../file.tar.gz?e=<token> — using it gives
      // us both the file path and the sharing access token so the downloader can authenticate.
      if (referrer) {
        try {
          const refParsed = new URL(referrer);
          if (refParsed.hostname.toLowerCase().endsWith('.sharepoint.com')) {
            const refSharingMatch = refParsed.pathname.match(/^\/:u:\/r\/(.*)/);
            if (refSharingMatch) {
              const filePath = refSharingMatch[1];
              const eToken = refParsed.searchParams.get('e');
              const directUrl = `${refParsed.origin}/${filePath}`;
              const result = eToken ? `${directUrl}?e=${encodeURIComponent(eToken)}` : directUrl;
              console.log('[MTD] Resolved ASPX URL via referrer:', result);
              return result;
            }
          }
        } catch {}
      }
    }

    return url;
  } catch {
    return url;
  }
}

function resolveArtifactoryUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // JFrog UI tree links are browse URLs, not direct file endpoints.
    // Convert to /artifactory/{repo}/{path} so the native downloader can fetch bytes.
    if (!host.includes('artifactory')) {
      return url;
    }

    let combinedPath = '';

    const treeMatch = parsed.pathname.match(/^\/ui\/repos\/tree\/General\/(.+)$/);
    if (treeMatch) {
      combinedPath = treeMatch[1];
    }

    // Newer Artifactory UI flow emits this URL for downloads:
    // /ui/api/v1/download?repoKey=<repo>&path=<encoded path>
    // Convert to /artifactory/<repo>/<path> for native CLI compatibility.
    if (!combinedPath && parsed.pathname === '/ui/api/v1/download') {
      const repoKey = parsed.searchParams.get('repoKey') || parsed.searchParams.get('repo');
      const queryPath = parsed.searchParams.get('path');
      if (repoKey && queryPath) {
        combinedPath = `${repoKey}/${queryPath}`;
      }
    }

    if (!combinedPath) {
      return url;
    }

    let decoded = combinedPath;
    for (let i = 0; i < 3; i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    }

    if (!decoded) {
      return url;
    }

    const normalizedPath = decoded
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    if (!normalizedPath) {
      return url;
    }

    return `${parsed.origin}/artifactory/${normalizedPath}`;
  } catch {
    return url;
  }
}

// Resolve an Artifactory URL to the endpoint that the browser session cookies can
// authenticate: the JFrog UI download API (`/ui/api/v1/download?repoKey=&path=`).
// The `/artifactory/` REST layer requires a token and returns 401 with cookies alone,
// so it is unsuitable for the cookie-based browser-stream fallback. The UI download
// endpoint is exactly what the browser uses for a normal download, so `fetch()` with
// `credentials: 'include'` succeeds against it.
function resolveArtifactoryStreamUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.toLowerCase().includes('artifactory')) {
      return url;
    }

    // Already the UI download endpoint — use verbatim to preserve the server's exact
    // (often double-) encoding of the path query parameter.
    if (parsed.pathname === '/ui/api/v1/download') {
      return url;
    }

    // Convert a UI tree/browse URL to the UI download endpoint.
    const treeMatch = parsed.pathname.match(/^\/ui\/repos\/tree\/General\/([^/]+)\/(.+)$/);
    if (treeMatch) {
      const repoKey = decodeURIComponent(treeMatch[1]);
      let path = treeMatch[2];
      for (let i = 0; i < 3; i += 1) {
        const next = decodeURIComponent(path);
        if (next === path) {
          break;
        }
        path = next;
      }
      const dl = new URL(`${parsed.origin}/ui/api/v1/download`);
      dl.searchParams.set('repoKey', repoKey);
      dl.searchParams.set('path', path);
      dl.searchParams.set('isNativeBrowsing', 'false');
      return dl.toString();
    }

    return url;
  } catch {
    return url;
  }
}


// Returns { token, type } or null. Tries multiple JFrog Platform endpoints in order.
async function fetchArtifactoryToken(hostname) {
  const CACHE_KEY = 'artifactoryTokens';
  const MAX_AGE_MS = 3_300_000; // 55 min (refresh before typical 1h expiry)

  try {
    const stored = await chrome.storage.session.get([CACHE_KEY]);
    const cache = stored[CACHE_KEY] || {};
    const entry = cache[hostname];
    if (entry && entry.token && (Date.now() - entry.cachedAt) < MAX_AGE_MS) {
      return { token: entry.token, type: entry.type };
    }
  } catch {}

  async function saveToken(token, type) {
    const stored = await chrome.storage.session.get([CACHE_KEY]).catch(() => ({}));
    const cache = stored[CACHE_KEY] || {};
    cache[hostname] = { token, type, cachedAt: Date.now() };
    chrome.storage.session.set({ [CACHE_KEY]: cache }).catch(() => {});
  }

  // Attempt 1: Artifactory API key (/artifactory/ layer)
  try {
    const r = await fetch(`https://${hostname}/artifactory/api/security/apiKey`, {
      credentials: 'include', headers: { Accept: 'application/json' },
    });
    if (r.ok) {
      const d = await r.json();
      if (d.apiKey) {
        await saveToken(d.apiKey, 'api_key');
        console.log('[MTD] Got Artifactory API key for', hostname);
        return { token: d.apiKey, type: 'api_key' };
      }
    }
    console.log('[MTD] /artifactory/api/security/apiKey:', r.status);
  } catch (e) { console.log('[MTD] apiKey endpoint error:', e.message); }

  // Attempt 2: JFrog Access Service — create a scoped token using the Platform session token.
  // The /access/ API requires Authorization: Bearer, not cookies. We read the Platform session
  // token from the __Host-ACCESSTOKEN httpOnly cookie (accessible via chrome.cookies API)
  // and use it explicitly as a Bearer token when calling the Access service.
  try {
    const allCookies = await chrome.cookies.getAll({ url: `https://${hostname}` });
    const sessionCookie = allCookies.find(c => c.name === '__Host-ACCESSTOKEN');
    const sessionToken = sessionCookie?.value || '';

    if (!sessionToken) {
      console.log('[MTD] __Host-ACCESSTOKEN not found for', hostname, '— skipping access token generation');
    } else {
      console.log('[MTD] Using __Host-ACCESSTOKEN to call /access/api/v1/tokens');
      const r = await fetch(`https://${hostname}/access/api/v1/tokens`, {
        method: 'POST',
        credentials: 'omit', // Send the token explicitly in the header, not as a cookie
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ scope: 'applied-permissions/user', expires_in: 3600 }),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.access_token) {
          await saveToken(d.access_token, 'bearer');
          console.log('[MTD] Generated access token via /access/api/v1/tokens for', hostname);
          return { token: d.access_token, type: 'bearer' };
        }
      }
      console.log('[MTD] /access/api/v1/tokens:', r.status, await r.text().catch(() => ''));
    }
  } catch (e) { console.log('[MTD] access token endpoint error:', e.message); }

  // Attempt 3: Use __Host-ACCESSTOKEN directly as a Bearer token for Artifactory REST API.
  // The Platform session token might work directly with the Artifactory layer depending on
  // the JFrog Platform version and configuration (JPD 7.38+ unified token model).
  try {
    const allCookies = await chrome.cookies.getAll({ url: `https://${hostname}` });
    const sessionCookie = allCookies.find(c => c.name === '__Host-ACCESSTOKEN');
    if (sessionCookie?.value) {
      // Quick validation: see if the Platform session token can authenticate Artifactory REST API
      const probe = await fetch(`https://${hostname}/artifactory/api/system/ping`, {
        credentials: 'omit',
        headers: { Authorization: `Bearer ${sessionCookie.value}`, Accept: 'application/json' },
      });
      if (probe.ok || probe.status === 200) {
        console.log('[MTD] __Host-ACCESSTOKEN works as Bearer for Artifactory REST API');
        await saveToken(sessionCookie.value, 'bearer');
        return { token: sessionCookie.value, type: 'bearer' };
      }
      console.log('[MTD] Direct Bearer probe on Artifactory REST API:', probe.status);
    }
  } catch (e) { console.log('[MTD] direct bearer probe error:', e.message); }

  console.warn('[MTD] All token endpoints failed for', hostname);
  return null;
}

// Convert Uint8Array → base64 string. Builds the binary string in small sub-chunks with
// String.fromCharCode.apply — spreading (or apply-ing) tens of thousands of elements at once
// overflows the call stack, so keep the sub-chunk well under that limit.
function uint8ArrayToBase64(bytes) {
  const SLICE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
  }
  return btoa(binary);
}

// Stream the file from `url` sequentially, sending 512KB chunks to the native host.
async function _streamSingle(url, streamId, signal) {
  const CHUNK = 512 * 1024;
  const resp = await fetch(url, { credentials: 'include', redirect: 'follow', signal });
  if (!resp.ok) throw new Error(`Browser stream: server returned HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  let pending = new Uint8Array(0);
  let offset = 0;

  for (;;) {
    if (signal?.aborted) throw new DOMException('Stream cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (value?.length) {
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending);
      merged.set(value, pending.length);
      pending = merged;
    }
    while (pending.length >= CHUNK || (done && pending.length > 0)) {
      const n = Math.min(CHUNK, pending.length);
      await sendNativeRequest('STREAM_CHUNK',
        { streamId, offset, data: uint8ArrayToBase64(pending.slice(0, n)) }, 60000);
      pending = pending.slice(n);
      offset += n;
    }
    if (done) break;
  }
}

// Stream the file using N parallel range requests. Each request pulls a large FETCH_SPAN
// (several MB) so the connection stays saturated; fetching only 512KB per request left the
// connections idle waiting on per-request round-trip/TLS latency, so throughput never scaled
// with thread count (the "slow even with 8 threads" symptom on high-latency Artifactory
// links). Each span is forwarded to the native host in <=SEND_CHUNK messages, because native
// messaging has a ~1MB per-message cap and base64 inflates the payload by ~33%.
async function _streamParallel(url, streamId, totalBytes, threads, signal) {
  const SEND_CHUNK = 512 * 1024;        // bytes per native STREAM_CHUNK message
  const FETCH_SPAN = 8 * 1024 * 1024;   // bytes pulled per HTTP range request
  const spans = [];
  for (let s = 0; s < totalBytes; s += FETCH_SPAN) {
    spans.push([s, Math.min(s + FETCH_SPAN - 1, totalBytes - 1)]);
  }
  console.log('[MTD] Parallel stream:', threads, 'threads,', spans.length, 'ranges');

  let failure = null;
  const workers = Array.from({ length: Math.min(threads, spans.length) }, async () => {
    while (spans.length > 0 && !failure) {
      if (signal?.aborted) {
        failure = new DOMException('Stream cancelled', 'AbortError');
        break;
      }
      const span = spans.shift();
      if (!span) break;
      const [start, end] = span;
      try {
        const resp = await fetch(url, {
          credentials: 'include',
          headers: { Range: `bytes=${start}-${end}` },
          signal,
        });
        if (!resp.ok && resp.status !== 206) {
          throw new Error(`Range ${start}-${end}: HTTP ${resp.status}`);
        }
        // Stream the span body to the native host in SEND_CHUNK-sized messages rather than
        // buffering the whole span in memory. Each message carries its own absolute offset,
        // which the native host uses to seek+write, so order across workers doesn't matter.
        const reader = resp.body.getReader();
        let pending = new Uint8Array(0);
        let offset = start;
        for (;;) {
          if (signal?.aborted) throw new DOMException('Stream cancelled', 'AbortError');
          const { done, value } = await reader.read();
          if (value?.length) {
            const merged = new Uint8Array(pending.length + value.length);
            merged.set(pending);
            merged.set(value, pending.length);
            pending = merged;
          }
          while (pending.length >= SEND_CHUNK || (done && pending.length > 0)) {
            // Stop immediately on cancel — otherwise workers keep flooding the single-threaded
            // native host with STREAM_CHUNK messages, which delays the queued CANCEL_STREAM and
            // makes the cancel button feel unresponsive (had to press it repeatedly).
            if (signal?.aborted) throw new DOMException('Stream cancelled', 'AbortError');
            const n = Math.min(SEND_CHUNK, pending.length);
            await sendNativeRequest('STREAM_CHUNK',
              { streamId, offset, data: uint8ArrayToBase64(pending.slice(0, n)) }, 60000);
            pending = pending.slice(n);
            offset += n;
          }
          if (done) break;
        }
      } catch (e) {
        failure = e;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

// Download a file by streaming it through the extension's fetch() — the browser handles all
// auth transparently (SAML, corporate proxy, client certs, NTLM, etc.) so this works for any
// enterprise setup where Python's urllib cannot authenticate.
async function startBrowserStreamDownload(downloadId, downloadInfo) {
  const settings = await getSettings();
  const outputDir = downloadInfo.downloadDir || settings.downloadDir;

  // Resolve provider-specific browse/sharing URLs to a cookie-authenticated download endpoint.
  // - Artifactory: JFrog UI tree/browse URLs -> /ui/api/v1/download (session-cookie auth).
  // - SharePoint: sharing URLs (/:u:/r/...) -> direct file path; download.aspx?UniqueId= URLs
  //   already work with the browser session (httpOnly FedAuth via credentials:'include').
  let downloadUrl = downloadInfo.url;
  const streamHost = (() => {
    try { return new URL(downloadInfo.url).hostname.toLowerCase(); } catch { return ''; }
  })();
  if (streamHost.includes('artifactory')) {
    downloadUrl = resolveArtifactoryStreamUrl(downloadInfo.url);
  } else if (streamHost.endsWith('.sharepoint.com')) {
    downloadUrl = resolveSharePointUrl(downloadInfo.url, downloadInfo.referrer || '');
  }
  if (downloadUrl !== downloadInfo.url) {
    console.log('[MTD] Browser stream using resolved URL:', downloadUrl);
  }

  // Probe: get file size, check range support, follow any redirects to final URL.
  let totalBytes = downloadInfo.totalBytes || 0;
  let acceptRanges = false;
  // Set when a ranged request returned HTML (e.g. SharePoint download.aspx). Ranged/parallel
  // streaming is then unsafe even if a later Accept-Ranges header claims support, so we force
  // single-thread plain-GET streaming.
  let rangedUnsupported = false;

  // Inspect a probe response's headers. Returns true if it looked like a valid file, or
  // false if the server returned an HTML page (a web UI / login page). When `htmlFatal` is
  // true an HTML response throws; otherwise the caller can retry a different method (some
  // endpoints, e.g. SharePoint download.aspx, return HTML for HEAD but the file for GET).
  const applyProbeHeaders = (resp, method, htmlFatal = true) => {
    const contentType = (resp.headers.get('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
      if (htmlFatal) {
        // Streaming an HTML page would save the web page as the download.
        throw new Error(
          'Browser stream got an HTML page instead of a file — the session may not be ' +
          'authenticated. Open the file in the browser first, then retry the download.'
        );
      }
      console.warn(`[MTD] Probe (${method}) returned HTML — will retry with ranged GET`);
      return false;
    }
    // Content-Range (from a ranged GET) reveals the true total size: "bytes 0-0/12345".
    const contentRange = resp.headers.get('Content-Range') || '';
    const rangeTotal = contentRange.includes('/') ? parseInt(contentRange.split('/')[1], 10) : NaN;
    if (Number.isFinite(rangeTotal) && rangeTotal > 0) {
      totalBytes = rangeTotal;
      acceptRanges = true;
    } else {
      const cl = resp.headers.get('Content-Length');
      if (cl) totalBytes = parseInt(cl, 10);
      acceptRanges = (resp.headers.get('Accept-Ranges') || '').toLowerCase().includes('bytes');
    }
    downloadUrl = resp.url || downloadUrl;
    console.log(`[MTD] Stream probe OK (${method}) — size:`, totalBytes, 'ranges:', acceptRanges);
    return true;
  };

  // A ranged GET doubles as a probe (size + range support) and an auth check. JFrog's UI
  // download endpoint typically rejects HEAD (403/405) but serves GET, so try GET first.
  // Returns true if it resolved a real file, false if it returned HTML (caller then falls
  // back to a plain GET — SharePoint download.aspx serves HTML for ranged requests but the
  // file for a plain GET).
  const probeWithRangedGet = async () => {
    const resp = await fetch(downloadUrl, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      headers: { Range: 'bytes=0-0' },
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(`Browser stream auth failed: HTTP ${resp.status}. Open the file in the browser first, then retry.`);
    }
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Browser stream probe failed: HTTP ${resp.status}`);
    }
    const ok = applyProbeHeaders(resp, 'GET', false);
    // Drain the tiny body so the connection can be reused/closed cleanly.
    await resp.arrayBuffer().catch(() => {});
    if (!ok) {
      // The server answered a ranged request with HTML — ranged/parallel streaming is unsafe.
      rangedUnsupported = true;
    }
    return ok;
  };

  // A plain GET (no Range header) is exactly what the browser's native download uses, so it
  // is the most reliable probe/auth check. We only read the headers, then cancel the body so
  // we don't pull the whole file here. HTML at this stage is a genuine auth failure.
  const probeWithPlainGet = async () => {
    const resp = await fetch(downloadUrl, {
      method: 'GET', credentials: 'include', redirect: 'follow',
    });
    if (resp.status === 401 || resp.status === 403) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`Browser stream auth failed: HTTP ${resp.status}. Open the file in the browser first, then retry.`);
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`Browser stream probe failed: HTTP ${resp.status}`);
    }
    try {
      applyProbeHeaders(resp, 'GET(plain)', true);
    } finally {
      // Don't download the whole file during the probe — cancel the body stream.
      await resp.body?.cancel().catch(() => {});
    }
  };

  try {
    const head = await fetch(downloadUrl, {
      method: 'HEAD', credentials: 'include', redirect: 'follow',
    });
    if (head.ok) {
      // HTML on HEAD is NOT fatal — some endpoints (SharePoint download.aspx) return an HTML
      // wrapper for HEAD but serve the real file on GET. Fall back to a GET in that case.
      if (!applyProbeHeaders(head, 'HEAD', false)) {
        if (!(await probeWithRangedGet())) {
          await probeWithPlainGet();
        }
      }
    } else if (head.status === 403 || head.status === 405) {
      // HEAD not allowed on this endpoint — fall back to a ranged GET.
      console.warn('[MTD] HEAD returned', head.status, '— retrying with ranged GET');
      if (!(await probeWithRangedGet())) {
        await probeWithPlainGet();
      }
    } else if (head.status === 401) {
      throw new Error(`Browser stream auth failed: HTTP ${head.status}. Open the file in the browser first, then retry.`);
    } else {
      console.warn('[MTD] HEAD probe returned', head.status, '— retrying with ranged GET');
      if (!(await probeWithRangedGet())) {
        await probeWithPlainGet();
      }
    }
  } catch (e) {
    if (/auth failed|HTML page|probe failed/.test(e.message)) throw e;
    console.warn('[MTD] HEAD probe error:', e.message, '— retrying with ranged GET');
    if (!(await probeWithRangedGet())) {
      await probeWithPlainGet();
    }
  }

  const canUseRanges = acceptRanges && !rangedUnsupported;
  const threads = (canUseRanges && totalBytes > 0) ? settings.threadCount : 1;
  console.log('[MTD] Starting browser stream — threads:', threads, 'file:', downloadInfo.filename);

  const startResult = await sendNativeRequest('START_STREAM', {
    downloadId: String(downloadId),
    filename: downloadInfo.filename,
    outputDir,
    totalBytes,
    threads,
    url: downloadUrl,
  });

  const streamId = startResult.streamId;

  // Stream the bytes in the background so the caller (and the intercept popup) is not blocked
  // for the entire download. START_STREAM has been acknowledged, so the download is underway;
  // progress/speed/ETA are reported via DOWNLOAD_UPDATE messages from the native host.
  const controller = new AbortController();
  const streamKey = String(downloadId);
  activeStreamDownloads.set(streamKey, { streamId, controller });
  (async () => {
    try {
      if (threads > 1 && canUseRanges && totalBytes > 0) {
        await _streamParallel(downloadUrl, streamId, totalBytes, threads, controller.signal);
      } else {
        await _streamSingle(downloadUrl, streamId, controller.signal);
      }
      await sendNativeRequest('END_STREAM', { streamId }, 30000);
      interceptedDownloads.delete(downloadId);
      console.log('[MTD] Browser stream download complete:', downloadInfo.filename);
    } catch (err) {
      if (err?.name === 'AbortError') {
        console.log('[MTD] Browser stream cancelled:', downloadInfo.filename);
      } else {
        console.error('[MTD] Browser stream download failed:', err);
      }
      sendNativeRequest('CANCEL_STREAM', { streamId }).catch(() => {});
    } finally {
      activeStreamDownloads.delete(streamKey);
    }
  })();

  return { streamId };
}

async function startDownload(downloadId, downloadInfo) {
  try {
    const settings = await getSettings();
    let outputDir = downloadInfo.downloadDir || settings.downloadDir;
    if (settings.createSubdir && !downloadInfo.skipSubdir) {
      outputDir = appendDomainSubdir(outputDir, downloadInfo.url);
    }
    const trimmedToken = typeof settings.authToken === 'string' ? settings.authToken.trim() : '';

    const sourceHostname = (() => {
      try { return new URL(downloadInfo.url || '').hostname.toLowerCase(); } catch { return ''; }
    })();
    const isSharePointSource = sourceHostname.endsWith('.sharepoint.com');
    const isArtifactorySource = sourceHostname.includes('artifactory');

    let resolvedUrl = downloadInfo.url;
    let artifactoryToken = null;

    if (isSharePointSource) {
      // Accelerate SharePoint the way XDM does: replay the browser's own captured request
      // headers (the SameSite FedAuth Cookie, User-Agent, Referer) from the native downloader,
      // which is a raw HTTP client not bound by SameSite. Merge the webRequest-observed cookie
      // union with chrome.cookies.getAll() (which can expose httpOnly cookies the header capture
      // missed) to maximize the chance of including FedAuth. If we still have no session cookie,
      // fall back to the browser's native (already-authenticated) download.
      let cookieStoreEntries = [];
      try {
        const spCookies = await chrome.cookies.getAll({ domain: 'sharepoint.com' });
        cookieStoreEntries = spCookies.map((c) => [c.name, c.value]);
      } catch (e) {
        console.warn('[MTD] chrome.cookies.getAll for SharePoint failed:', e.message);
      }

      const captured = getCapturedSharePointHeaders(downloadInfo.url, sourceHostname, cookieStoreEntries);
      const hasFedAuth = captured && captured.cookieNames.some((n) => n.toLowerCase() === 'fedauth');
      if (captured && captured.cookie) {
        console.log('[MTD] SharePoint — accelerating with browser session cookies:', captured.cookieNames.join(', '));
        if (!hasFedAuth) {
          console.warn('[MTD] SharePoint — FedAuth cookie not found; download may fail (auth cookie is httpOnly/SameSite)');
        }
        const spPayload = {
          url: downloadInfo.url,
          threads: settings.threadCount,
          filename: downloadInfo.filename,
          outputDir,
          totalBytes: downloadInfo.totalBytes || 0,
          referrer: captured.referer || downloadInfo.referrer || '',
          cookies: captured.cookie,
          userAgent: captured.userAgent || '',
        };
        const spResult = await sendNativeRequest('START_DOWNLOAD', spPayload, 30000);
        console.log('[MTD] SharePoint download started:', spResult.downloadId);
        if (spResult.commandPreview) {
          console.log('[MTD] Downloader command:', spResult.commandPreview);
        }
        interceptedDownloads.delete(downloadId);
        return { downloadId: spResult.downloadId };
      }

      console.log('[MTD] SharePoint — no captured session headers; using browser native download');
      const browserDownloadId = await startNativeBrowserDownload(downloadId, downloadInfo);
      return { browserDownloadId, browserFallback: true };
    } else if (isArtifactorySource) {
      // Fetch an Artifactory token via the browser's fetch() (full SAML/proxy auth context).
      // Tries: API key → /access/api/v1/tokens (Platform layer) → Platform identity token.
      // With a valid token we use the direct /artifactory/ path (supports range requests).
      // Without one, fall back to the UI URL with session cookies.
      artifactoryToken = await fetchArtifactoryToken(sourceHostname);
      if (artifactoryToken) {
        resolvedUrl = resolveArtifactoryUrl(downloadInfo.url);
        if (resolvedUrl !== downloadInfo.url) {
          console.log('[MTD] Resolved Artifactory URL:', resolvedUrl);
        }
      } else {
        // All token endpoints failed — fall back to browser streaming proxy.
        // The extension's fetch() uses the browser's full auth context so it can download
        // files that Python's urllib cannot authenticate with (SAML, proxy, certs, etc.).
        console.log('[MTD] No Artifactory token — switching to browser streaming proxy');
        return startBrowserStreamDownload(downloadId, downloadInfo);
      }
    }

    const payload = {
      url: resolvedUrl,
      threads: settings.threadCount,
      filename: downloadInfo.filename,
      outputDir,
      totalBytes: downloadInfo.totalBytes || 0,
      referrer: downloadInfo.referrer || ''
    };

    // Extract cookies from the URL's domain to pass authentication
    try {
      const urlObj = new URL(resolvedUrl);
      const isSharePoint = isSharePointSource;
      const isArtifactory = isArtifactorySource;
      // For Artifactory, cookies are scoped to the origin — use the original URL so __Host- cookies are found
      const cookieLookupUrl = isArtifactory ? downloadInfo.url : resolvedUrl;
      const cookies = await chrome.cookies.getAll({ url: cookieLookupUrl });

      if (trimmedToken) {
        // User has explicitly set a token in Settings — always use it.
        payload.token = trimmedToken;
      } else if (isArtifactory) {
        // 1. Use a webRequest-captured token (for Artifactory instances with header-based auth).
        const captured = capturedArtifactoryAuth[sourceHostname];
        const TOKEN_MAX_AGE_MS = 3_600_000;
        if (captured && captured.value && (Date.now() - captured.capturedAt) < TOKEN_MAX_AGE_MS) {
          payload.token = captured.value;
          payload.authType = captured.type === 'bearer' ? 'bearer' : 'api-key';
          console.log('[MTD] Using captured browser token for', sourceHostname, '(type:', captured.type + ')');
        }
        // 2. Use the token fetched above via browser's auth context.
        if (!payload.token && artifactoryToken) {
          payload.token = artifactoryToken.token;
          payload.authType = artifactoryToken.type === 'bearer' ? 'bearer' : 'api-key';
          console.log('[MTD] Using fetched Artifactory token for', sourceHostname, '(type:', artifactoryToken.type + ')');
        }
      }
      // For SharePoint: rely on browser cookies for session auth

      if (cookies && cookies.length > 0) {
        // For SharePoint, sending every cookie (analytics, MSAL cache, SPA tokens, etc.)
        // can push the Cookie header past IIS's ~8 KB limit, causing silent auth failures.
        // Only the core session cookies are needed for file download auth.
        let relevantCookies = cookies;
        if (isSharePoint) {
          const authNames = new Set(['FedAuth', 'rtFa', 'SIMI', 'OIDCauth']);
          const authCookies = cookies.filter(c => authNames.has(c.name) || c.name.startsWith('sig1.'));
          if (authCookies.length > 0) {
            console.log('[MTD] SharePoint: filtered to', authCookies.length, 'auth cookies (from', cookies.length, 'total)');
            relevantCookies = authCookies;
          }
        } else if (!isArtifactory) {
          // For other sources, pass all cookies
          // Artifactory auth is handled via BOSE_ARTIFACTORY_TOKEN environment variable
        }
        if (relevantCookies.length > 0) {
          const cookieStrings = relevantCookies.map(c => `${c.name}=${c.value}`);
          payload.cookies = cookieStrings.join('; ');
          console.log('[MTD] ✓ Extracted', relevantCookies.length, 'cookies for', urlObj.hostname);
        }
      } else {
        console.warn('[MTD] ⚠ No cookies found for', urlObj.hostname);
      }
    } catch (cookieError) {
      console.warn('[MTD] Could not extract cookies:', cookieError);
      // Continue without cookies - some downloads may not need them
    }

    const result = await sendNativeRequest('START_DOWNLOAD', payload, 30000);
    console.log('[MTD] Download started:', result.downloadId);
    if (result.commandPreview) {
      console.log('[MTD] Downloader command:', result.commandPreview);
    }
    interceptedDownloads.delete(downloadId);
  } catch (error) {
    console.error('[MTD] Failed to start native download:', error);
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create(`mtd-error-${downloadId}`, {
        type: 'basic',
        iconUrl: '/images/icon-128.png',
        title: 'HyperFetch',
        message: `Failed to start download: ${error.message}`
      });
    }
    throw error;
  }
}

chrome.storage.session.get({ capturedArtifactoryAuth: {} })
  .then(data => { capturedArtifactoryAuth = data.capturedArtifactoryAuth || {}; })
  .catch(() => {});

setTimeout(() => {
  console.log('[MTD] Initialization timer fired');
  connectNativeHost();
  setupArtifactoryTokenCapture();
  refreshRuntimeSettings().finally(() => {
    setupListeners();
  });
}, 100);

console.log('[MTD] Script initialization scheduled');