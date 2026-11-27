# Security Policy

## Supported versions

HearBridge is pre-1.0. Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Please do not report security issues in public issues or discussions.**

Use GitHub's private reporting instead: go to the repository's **Security** tab → **Report a vulnerability**
(<https://github.com/devnonla/hearbridge/security/advisories/new>).

Please include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- affected version / macOS version.

You can expect an acknowledgement within a few days. We will keep you updated while we investigate and credit you in the release notes unless you prefer to stay anonymous.

## Scope and data handling notes

- The OpenRouter API key is stored **locally** in `~/Library/Application Support/hearbridge/settings.json` (plain JSON, user-readable). Anyone with access to your user account can read it. Rotate the key if you suspect exposure.
- Audio and transcripts are sent to the model providers you select via OpenRouter. Review their data policies before using HearBridge for sensitive audio.
- Apple Speech, Translation and TTS run on-device when available.
