# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-27

> Early development build: expect rough edges.

### Changed
- New interface built with NonlaUI, always in light mode. Settings open full screen with two tabs, **Nghe** (listen) and **Nói** (speak), each showing its whole pipeline at a glance.
- Speech recognition and translation now run on-device with Apple in both directions (no API key needed). Recognising your own voice needs macOS Dictation turned on.
- The listen side reads translations with Siri only (fastest). Their language is English for now.
- Captions are split only at sentence ends, not at commas, and short fragments wait a little to join the rest of the sentence.
- OpenRouter API key and models are configured only in the in-app Settings; `.env` support has been removed.

### Added
- Chat-style timeline: their messages on the left, yours on the right, with names, avatars and times. English in blue, Vietnamese in orange; the speaker's original line on top.
- Continuous talk mode next to hold-to-talk: the mic stays open and each sentence is translated when you pause.
- Your translated voice can be sent to Discord / Zoom / Meet through a virtual mic, with a one-click BlackHole 2ch install and an option to hear it yourself.
- Kokoro on-device voices (54 voices, model downloaded on first use) for the speak side; voice preview button and speed control.
- Per-step latency in the status line, and a live signal meter while listening.
- In-app updates: HearBridge checks GitHub releases shortly after launch and every hour, shows the new version with its release notes, and installs it with a restart only when you choose to. Updates are signed and verified before install.
- New app icon: an arch bridge whose hangers are a sound waveform.
- Release pipeline: pushing a `vX.Y.Z` tag builds the Apple Silicon `.dmg` and the signed update archive and publishes the GitHub release with `latest.json`. `bun run release` bumps the version, rolls this changelog, commits and tags. Developer ID signing and notarization turn on when the Apple secrets are configured.
- Open-source project files: contributing guide, code of conduct, security policy, issue/PR templates, CI.

### Fixed
- Listening could hang forever when starting (system audio stop deadlocked on its own lock).
- The app crashed when a Kokoro voice used an unsupported language code (British, French, Chinese voices).
- Choosing an output device had no effect in the app's webview; voices now play natively on the chosen device.
- Hold-to-talk no longer blocks the next sentence, drops earlier ones, or starts recording while typing a space in a text field.

## [0.1.0] - 2026-11-16

### Added
- Initial public release: live captions and interpretation of any app or mic audio on macOS (Tauri 2 + React).
- Per-app audio capture via ScreenCaptureKit and microphone listening.
- STT → translate → on-device Apple TTS pipeline through OpenRouter.
- Word list, model selection, always-on-top window.

[Unreleased]: https://github.com/devnonla/hearbridge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/devnonla/hearbridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devnonla/hearbridge/releases/tag/v0.1.0
