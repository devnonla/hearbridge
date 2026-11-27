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

Download the latest `HearBridge_*_aarch64.dmg` from [Releases](https://github.com/devnonla/hearbridge/releases), open it and drag **HearBridge** to **Applications**.

> **macOS says the app is "damaged" or can't be opened?**
> HearBridge is open source and not notarized with a paid Apple Developer ID, so Gatekeeper quarantines the download. Remove the quarantine flag once:
>
> ```bash
> xattr -cr /Applications/HearBridge.app
> ```
>
> Then open it normally. (Alternative: *System Settings → Privacy & Security → Open Anyway*.)

Requirements: macOS 14.4+ on Apple Silicon (macOS 15+ for Apple on-device translation).

On first launch open **Settings** and paste your [OpenRouter](https://openrouter.ai) API key, then grant **Microphone**, **Speech Recognition** and **Screen & System Audio Recording** when asked.

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

Works with **any app that plays audio**: video calls (Zoom, Meet, Teams, Slack huddles), browsers, YouTube, streaming, podcasts, webinars, local video players.

1. Turn on **Listen**, pick **Audio by app**, then choose the app from the list — grant **Screen & System Audio Recording** to HearBridge when asked.
2. Play the audio in that app only; other apps' sound is not captured.
3. Use **Mic** instead to caption a room or an external speaker.

### Speaking into a call (optional)

To let the other side of a call hear the interpreted voice, route HearBridge's TTS into the call with [BlackHole 2ch](https://existential.audio/blackhole/): set HearBridge's speaker output to **BlackHole 2ch** and the call app's microphone to **BlackHole 2ch**. Skip this if you only want captions or to hear the translation yourself.

## Data

Settings are stored locally in `~/Library/Application Support/hearbridge/settings.json` (including your OpenRouter API key). Nothing else is written to disk.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes live in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with any commercial “Cicada” product.
