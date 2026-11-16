# HearBridge

Open-source macOS app for **live meeting captions / simultaneous interpretation**: listen to Zoom/Meet (or mic), translate, speak back with on-device TTS, and save notes.

Built with **Tauri 2 + React**. Cloud models go through **OpenRouter**; Apple Speech / Siri TTS / Translation run on-device when available.

## Features

- **Listen by app** — ScreenCaptureKit captures only the selected app’s audio (Zoom/Meet/Chrome…), then STT → translate → captions
- **Mic listen** — rooms / external speaker
- **Apple TTS** — including neural Siri voices via private `SiriTTSService` when installed
- **Meetings** — local save, reopen, Markdown / SRT export
- **Word list**, model picks, always-on-top window

## Setup

```bash
cp .env.example .env
# put OPENROUTER_API_KEY in .env

bun install
bun run tauri:dev
```

Requires macOS (Apple Silicon recommended), Bun, Rust, Xcode Command Line Tools.

## Zoom / Meet

1. Turn on **Listen**, pick **Audio by app**, choose Zoom/Meet/Chrome — grant **Screen & System Audio Recording** to HearBridge.
2. Play the meeting in that app only.
3. Optional: [BlackHole 2ch](https://existential.audio/blackhole/) to route interpreting TTS into the call.

## Data

`~/Library/Application Support/hearbridge/`

- `settings.json`
- `meetings/*.json`

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with any commercial “Cicada” product.
