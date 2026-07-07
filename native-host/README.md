# HyperFetch Native Host

This folder contains the Chrome Native Messaging host used by the extension.

## Why this exists

The extension now talks to this local host directly instead of calling a Flask server on localhost.

## Linux setup

1. Find your extension ID in `chrome://extensions`.
2. Register the host for that extension:

```bash
cd native-host
chmod +x native_host.py install-host.sh
./install-host.sh YOUR_EXTENSION_ID
```

3. Reload the extension in Chrome.
4. Open extension settings and click **Test Native Host**.

## Installed manifest location

`~/.config/google-chrome/NativeMessagingHosts/com.hyperfetch.host.json`

## Message protocol (summary)

Request fields:
- `type`: command name
- `payload`: command object
- `requestId`: unique id from extension

Response fields:
- `type`: `RESPONSE`
- `requestId`: original request id
- `ok`: boolean
- `result` or `error`

Push update fields:
- `type`: `DOWNLOAD_UPDATE`
- `download`: current download snapshot
