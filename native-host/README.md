# HyperFetch Native Host

This folder contains the Native Messaging host used by the Chrome, Edge, and Firefox
extensions.

## Why this exists

The extension now talks to this local host directly instead of calling a Flask server on localhost.

## Linux setup

1. Register the host:

```bash
cd native-host
chmod +x native_host.py install-host.sh
./install-host.sh <chrome_extension_id>
./install-host-edge.sh <edge_extension_id>
./install-host-firefox.sh hyperfetch@hyperfetch.local
```

2. Reload the extension in your browser.
4. Open extension settings and click **Test Native Host**.

## Installed manifest location

- Chrome: `~/.config/google-chrome/NativeMessagingHosts/com.hyperfetch.host.json`
- Edge: `~/.config/microsoft-edge/NativeMessagingHosts/com.hyperfetch.host.json`
- Firefox: `~/.mozilla/native-messaging-hosts/com.hyperfetch.host.json`

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
