# HyperFetch - Chrome Extension

Accelerate large file downloads (>100MB) using parallel threads with this Chrome extension.

## Quick Start

### 1️⃣ Install Native Host
```bash
cd native-host
chmod +x native_host.py install-host.sh

# Get extension ID from chrome://extensions, then register host
./install-host.sh YOUR_EXTENSION_ID
```

### 2️⃣ Install Extension
- Go to `chrome://extensions/`
- Enable Developer mode
- Click "Load unpacked"
- Select the `chrome-extension` folder
- Click the extension icon and configure settings

### 3️⃣ Download Large Files
Simply download any file > 100MB - the extension will offer to speed it up with parallel threads!

## Features

✨ **Automatic Interception**
- Detects large downloads automatically
- Shows prompt to use parallel download

⚡ **Parallel Downloads**
- Configurable thread count (1-32)
- Typically 4-8x faster than single-threaded
- Smart fallback for servers that don't support ranges

📊 **Progress Tracking**
- Real-time progress bars
- Current speed and ETA
- Download history

🔐 **Authentication Support**
- API keys (Artifactory)
- Bearer tokens
- Basic auth

⚙️ **Customizable Settings**
- Thread count per download
- Custom download directory
- Token management
- Download size threshold

## How It Works

1. **Detection**: Extension detects when a download > 100MB starts
2. **Interception**: Cancels the browser download
3. **Parallel**: Sends request to Native Messaging host which uses multiple threads
4. **Progress**: Native host pushes real-time updates to extension popup
5. **Save**: File saved to specified directory

## Requirements

- Chrome 88+
- Python 3.7+
- Linux, macOS, or Windows

## Configuration

Click the extension icon → **Settings** tab:

| Setting | Default | Description |
|---------|---------|-------------|
| Thread Count | 8 | Parallel download threads |
| Min File Size | 100 MB | Files below this use single-thread |
| Download Directory | Browser default | Where to save files |

## Troubleshooting

**Downloads still using single thread?**
- Server may not support byte ranges
- Check server header: `curl -I https://example.com/file.zip | grep Accept-Ranges`

**Native host not connecting?**
- Verify host manifest exists at `~/.config/google-chrome/NativeMessagingHosts/com.hyperfetch.host.json`
- Confirm the extension ID in `allowed_origins` exactly matches your installed extension
- Click **Test Native Host** in extension settings
- Open extension service worker logs from `chrome://extensions` for details

**Large files still download slowly?**
- Increase thread count in settings
- Check your network speed
- Some servers may throttle downloads
- Parallel downloads work best with high-speed connections

## Files

```
├── manifest.json              # Extension metadata
├── src/
│   ├── background.js          # Download interception
│   ├── popup.html             # Download list UI
│   ├── popup.js
│   ├── popup.css
│   ├── options.html           # Settings page
│   ├── options.js
│   └── options.css
└── README.md                  # This file
```

## Native Messaging Commands

The extension communicates with the local host using JSON messages:

- `PING` - Host health check
- `START_DOWNLOAD` - Start a threaded download
- `LIST_DOWNLOADS` - List active/history downloads
- `CANCEL_DOWNLOAD` - Cancel active download
- `OPEN_DOWNLOAD_DIRECTORY` - Open download folder
- `CLEAR_HISTORY` - Remove stored completed/error history

## Performance

- **Best**: High-speed connections (> 50 Mbps) with servers supporting ranges
- **Good**: Medium connections (10-50 Mbps)
- **Limited**: Low-speed connections (< 5 Mbps) - marginal benefit

**Thread Count Recommendation**:
- Network fast & stable: 8-16 threads
- Average network: 4-8 threads
- Unstable network: 2-4 threads

## Security

✅ Tokens stored securely in Chrome's encrypted storage
✅ No local HTTP server/port exposure
✅ Respects browser security policies
⚠️ Do not expose server to the internet without proper firewall

## Advanced Usage

### Custom Download Directory
Set in Settings → Download Directory, or use expandable path:
- `~/Downloads` → User's Downloads folder
- `/tmp` → System temp directory
- `/path/to/folder` → Full absolute path

### Native Host Registration (Linux)
```bash
cd native-host
./install-host.sh YOUR_EXTENSION_ID
```

This creates:

`~/.config/google-chrome/NativeMessagingHosts/com.hyperfetch.host.json`

## FAQ

**Q: Will this work with all websites?**
A: Only if the server supports HTTP byte-ranges. Most don't restrict this, but some may.

**Q: Is my internet speed limited?**
A: No, parallel downloads don't bypass speed limits. They help utilize available bandwidth better.

**Q: Can I use this for streaming video downloads?**
A: This is for file downloads. Video is typically handled differently by sites.

**Q: Does this work offline?**
A: No, you need an active internet connection for downloads. No always-on server process is required.

**Q: Can I run the native host on another machine?**
A: No. Native Messaging host must run on the same machine as Chrome.

## Contributing

To improve the extension or report bugs, check the main project README.

## License

This extension wraps the HyperFetch project. See the main README for licensing details.

---

Made with ❤️ for faster downloads! 🚀
