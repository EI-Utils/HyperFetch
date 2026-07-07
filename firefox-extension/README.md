# HyperFetch — Firefox Extension

Firefox build of HyperFetch. It shares the same UI and native messaging host as the Chrome
extension, with a Firefox-specific manifest and native host registration.

> **New here?** For install and usage, follow the
> [main README → Firefox extension](../README.md#firefox-extension). This document covers
> the Firefox-specific build details: producing the signed `.xpi`, native host locations,
> and how the Firefox build differs from Chrome.

## Building the signed add-on (`hyperfetch.xpi`)

Regular Firefox only keeps *signed* add-ons installed across restarts. Mozilla signs add-ons
for free on the **unlisted** channel (self-distribution, not published to the store). This is a
**one-time developer step** — the resulting `hyperfetch.xpi` installs on any regular Firefox
with no account needed by the end user.

1. Create a free account and generate API keys at
   [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/).
2. Sign and package:

   ```bash
   export AMO_JWT_ISSUER="user:12345:67"        # "JWT issuer" from the API Keys page
   export AMO_JWT_SECRET="abcdef0123456789..."  # "JWT secret" from the API Keys page
   ./sign-firefox.sh
   ```

   This installs `web-ext` locally on first run, uploads the add-on for signing, and writes the
   signed build to `hyperfetch.xpi` (and `web-ext-artifacts/`).

3. Distribute `hyperfetch.xpi`. Users install it via `about:addons` → gear icon →
   **Install Add-on From File…**.

> **Re-signing:** the signature is tied to the extension ID and version. If you bump `version`
> in [manifest.json](manifest.json), re-run `./sign-firefox.sh` to produce a new signed build.

> **Alternative (no signing):** Firefox Developer Edition / ESR / Nightly can install unsigned
> `.xpi` files permanently if you set `xpinstall.signatures.required` to `false` in
> `about:config`.

## Native host installation

`setup.sh firefox` (from the project root) handles this. To install directly:

```bash
cd native-host
chmod +x native_host.py install-host-firefox.sh

# The Firefox extension ID is fixed in manifest.json (hyperfetch@hyperfetch.local),
# so no argument is needed. Pass a custom ID only if you changed it in the manifest.
./install-host-firefox.sh
```

This writes the host manifest to `~/.mozilla/native-messaging-hosts/com.hyperfetch.host.json`.

> **Snap / Flatpak Firefox (Ubuntu default):** a sandboxed Firefox does **not** read
> `~/.mozilla/native-messaging-hosts/`, so native messaging silently fails. The installer
> detects this and also writes the manifest to:
> - Snap: `~/snap/firefox/common/.mozilla/native-messaging-hosts/`
> - Flatpak: `~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/`
>
> The `native_host.py` script must also live under your home directory (a non-hidden path) so the
> sandbox can execute it. For Flatpak you may additionally need:
> `flatpak override --user --filesystem=home org.mozilla.firefox`
>
> Even with the manifest in place, some sandboxed Firefox builds cannot launch native hosts at
> all — if **Test Native Host** keeps failing, use the non-snap Firefox (Mozilla APT `.deb` or
> the official tarball).

## Key differences from the Chrome build

| Area | Chrome | Firefox |
|------|--------|---------|
| Manifest background | `service_worker` | `background.scripts` (event page) |
| Extension identity | `key` field / auto ID | `browser_specific_settings.gecko.id` |
| Options page | `options_page` | `options_ui` |
| Native host manifest | `allowed_origins` (`chrome-extension://ID/`) | `allowed_extensions` (gecko ID) |
| Native host location | `~/.config/google-chrome/NativeMessagingHosts/` | `~/.mozilla/native-messaging-hosts/` |
| `downloads.onDeterminingFilename` | Supported (late filename correction) | Not available — interception uses `downloads.onCreated` only |
| `webRequest` `extraHeaders` | Required to observe Cookie/Referer | Not used (Firefox exposes them by default) |

These divergences are handled at runtime via an `IS_FIREFOX` check in
[src/background.js](src/background.js); the rest of the source is identical to the Chrome build.

## Firefox-specific troubleshooting

For general troubleshooting see the [main README → Troubleshooting](../README.md#-troubleshooting).
Firefox-only notes:

- **Native host not connecting?** Verify the manifest exists at
  `~/.mozilla/native-messaging-hosts/com.hyperfetch.host.json` (and the sandboxed Snap/Flatpak
  locations above). Confirm `allowed_extensions` contains the exact gecko ID from
  [manifest.json](manifest.json). Check the extension console via `about:debugging` → **Inspect**.
- **Filename not corrected before the prompt?** Firefox lacks `downloads.onDeterminingFilename`,
  so the filename shown comes from `downloads.onCreated`. You can edit it in the intercept prompt
  before starting.

## Files

```
firefox-extension/
├── manifest.json              # Firefox MV3 manifest
├── sign-firefox.sh            # Signs the add-on via AMO → hyperfetch.xpi
├── src/                       # Shared UI + background logic (Firefox-tweaked)
│   ├── background.js
│   ├── popup.html / popup.js / popup.css
│   ├── options.html / options.js / options.css
│   └── intercept.html / intercept.js / intercept.css
└── images/                    # Icons

native-host/
├── com.hyperfetch.host.firefox.template.json   # allowed_extensions template
└── install-host-firefox.sh                     # Firefox host installer
```

## License

This extension wraps the HyperFetch project. See the [main README](../README.md) for licensing.

