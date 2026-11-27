# HearBridge

[![CI](https://github.com/devnonla/hearbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/devnonla/hearbridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

> [!WARNING]
> **Đang phát triển (early development).** HearBridge is a work in progress: features, settings and the UI change often, and you may hit bugs or crashes. Please [open an issue](https://github.com/devnonla/hearbridge/issues) when something breaks.

Open-source macOS app for **live captions and simultaneous interpretation of any audio**: listen to any app (Zoom, Meet, Teams, YouTube, a browser tab, a video player…) or the mic, transcribe, translate, and speak the result back with on-device TTS.

Built with **Tauri 2 + React**. Cloud models go through **OpenRouter**; Apple Speech / Siri TTS / Translation run on-device when available.

## Features

- **Listen by app** — ScreenCaptureKit captures only the selected app’s audio — any app that plays sound (Zoom, Meet, Teams, Chrome, YouTube, Podcasts, VLC…) — then STT → translate → captions
- **Mic listen** — rooms / external speaker
- **On-device by default** — Apple speech recognition and Apple Translation, no API key needed
- **Interpret your own voice** — hold-to-talk or continuous mode; the translated voice can go into Discord / Zoom / Meet through a virtual mic (one-click BlackHole install)
- **Voices** — Siri (including neural Siri voices via private `SiriTTSService`), on-device **Kokoro** (54 voices, downloaded on first use), or an OpenRouter TTS model
- **Chat-style timeline** with avatars; original line on top, translation below
- Always-on-top window, in-app updates

## Install

Requirements: **macOS 14.4+ on Apple Silicon** (M1 or newer). On-device translation needs macOS 15+.

### One-line install

Paste into **Terminal**:

```bash
curl -fsSL https://raw.githubusercontent.com/devnonla/hearbridge/main/scripts/install.sh | bash
```

It downloads the latest `.dmg` from [Releases](https://github.com/devnonla/hearbridge/releases), copies **HearBridge** into `/Applications` (or `~/Applications` if `/Applications` isn't writable), removes the download quarantine flag and opens the app. Run the same line again to update. Read [`scripts/install.sh`](scripts/install.sh) first if you like; `HEARBRIDGE_DRY_RUN=1` prints what it would do, `HEARBRIDGE_VERSION=0.2.0` picks a version.

### Manual install

1. Download `HearBridge_<version>_aarch64.dmg` from the [latest release](https://github.com/devnonla/hearbridge/releases/latest).
2. Open the `.dmg` and drag **HearBridge** onto **Applications**. Eject the disk image.
3. HearBridge is open source and **not notarized** with a paid Apple Developer ID yet, so macOS quarantines the download and may say the app *"is damaged"* or *"can't be opened"*. Remove the quarantine flag once in **Terminal**:

   ```bash
   xattr -cr /Applications/HearBridge.app
   ```

   (Or: open it once, then *System Settings → Privacy & Security → Open Anyway*.)
4. Open **HearBridge** from Applications.

### First launch

1. **Permissions** — allow each one when macOS asks (you can change them later in *System Settings → Privacy & Security*):
   - **Microphone** — to translate what you say.
   - **Speech Recognition** — on-device captions.
   - **Screen & System Audio Recording** — to hear one app (Zoom, Meet, Discord, Chrome…). Only that app's audio is captured, never the screen.
2. **Dictation, for your own voice** — recognising what *you* say (e.g. Vietnamese) uses Apple's on-device speech model, which macOS only enables with Dictation: *System Settings → Keyboard → Dictation* → turn it on and add your language. Wait for the language download to finish.
3. **Translation languages** — *System Settings → General → Language & Region → Translation Languages*: download English and your language. HearBridge shows whether each pack is installed in **Settings**.
4. **Pick what to listen to** — click the app button in the top bar (e.g. Chrome or Discord), then **Bắt đầu nghe** (Start listening).
5. **Speak** — hold **Space** or **⌥** (or switch to *Nói liên tục*, continuous mode), talk, release: the translation is read out.

### Use it in a call (Discord / Zoom / Meet)

So the other person hears your translated voice:

1. In HearBridge: **Settings → Nói → Giọng đọc cho người kia**. If there's no virtual mic yet, click **Cài mic ảo BlackHole** (free, open source; asks for your Mac password once). HearBridge selects it as *Phát tới*.
2. Choose **Kokoro** (on-device, downloaded on first use) or **API** as the voice — Siri voices can't be routed into a virtual mic.
3. In the call app's audio settings set **Input device / Microphone = BlackHole 2ch**, and turn **off** noise suppression (Krisp), echo cancellation and automatic gain control so the voice isn't filtered out.
4. Use headphones, so the app doesn't pick up the other side through your speakers.

### Optional

- **OpenRouter API key** (*Settings → Chung*) — only needed if you choose **API** as a voice.
- **Kokoro voices** — the ~350 MB model downloads the first time you pick Kokoro.

### Uninstall

```bash
rm -rf /Applications/HearBridge.app ~/Applications/HearBridge.app "$HOME/Library/Application Support/hearbridge"
```

BlackHole, if installed, is removed with its own uninstaller or `sudo rm -rf /Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver && sudo killall coreaudiod`.

### Updates

HearBridge updates itself: it checks [GitHub Releases](https://github.com/devnonla/hearbridge/releases) shortly after launch and every hour, shows the new version and its notes, and installs it only when you click **Install and Restart** (it asks first while captions are running). Updates are signed and verified before they are installed. Because releases are not notarized yet, macOS may ask for the audio / screen recording permissions again after an update.

## Build from source

```bash
bun install
bun run tauri:dev
```

Then open **Settings** in the app and paste your OpenRouter API key.

Requires macOS (Apple Silicon), Bun, Rust, Xcode Command Line Tools.

`bun run tauri:dev` runs the app from `~/Applications/HearBridge Dev.app` (see `scripts/macos-dev-app-runner.sh`) so macOS remembers its permissions between rebuilds. Dev builds never update themselves.

To produce a release `.app` and `.dmg` locally:

```bash
bun run build:app             # → src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}
```

## Releasing

Maintainers: `bun run release patch|minor|major`, then push the commit and tag. GitHub Actions builds the `.dmg` and the signed update archive and publishes the release with `latest.json` for the in-app updater. Details, signing keys and secrets: [docs/RELEASING.md](docs/RELEASING.md).

## Listening to an app

Works with **any app that plays audio**: video calls (Zoom, Meet, Teams, Discord, Slack huddles), browsers, YouTube, streaming, podcasts, webinars, local video players. Pick the app in the top bar and press **Bắt đầu nghe**; only that app's sound is captured. To let the other side of a call hear your translated voice, see [Use it in a call](#use-it-in-a-call-discord--zoom--meet).

## Data

Settings are stored locally in `~/Library/Application Support/hearbridge/` (`settings.json`, including your OpenRouter API key if you set one, and the Kokoro model under `models/`). Device picks, profile names and avatars stay in the app's local storage. Captions are not saved to disk. Speech recognition and translation run on your Mac; only the **API** voice sends text to OpenRouter.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes live in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with any commercial “Cicada” product.
