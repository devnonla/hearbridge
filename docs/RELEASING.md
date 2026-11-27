# Releasing HearBridge

Releases are built by GitHub Actions ([`release.yml`](../.github/workflows/release.yml)) when a `vX.Y.Z` tag is pushed. Each release carries:

| File | Used by |
| --- | --- |
| `HearBridge_<version>_aarch64.dmg` | people installing for the first time |
| `HearBridge_<version>_aarch64.app.tar.gz` + `.sig` | the in-app updater (signed archive) |
| `latest.json` | the update feed installed apps read |

`package.json` holds the version. `src-tauri/tauri.conf.json` reads it (`"version": "../package.json"`) and `scripts/version.ts` keeps `src-tauri/Cargo.toml` / `Cargo.lock` in step. CI fails when they disagree (`bun run version:check`).

## Cut a release

1. Make sure everything for the release is on `main` and `CHANGELOG.md` has the notes under `## [Unreleased]` ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style: `### Added`, `### Changed`, `### Fixed`, `### Removed`). Those notes become the GitHub release body and the text shown in the app's update banner, so write them for users.
2. From a clean `main`:

   ```bash
   bun run release patch          # or minor, major, 1.4.0, 1.4.0-beta.1
   ```

   This bumps `package.json`, `Cargo.toml`, `Cargo.lock`, moves the Unreleased notes under `## [x.y.z] - <today>`, updates the compare links, runs `bun run build` and `cargo check`, then commits `chore: release vX.Y.Z` and creates the tag `vX.Y.Z`. Nothing is pushed yet.
3. Push the commit and the tag (or pass `--push` in step 2):

   ```bash
   git push origin main && git push origin vX.Y.Z
   ```

4. Watch [the Release workflow](https://github.com/devnonla/hearbridge/actions/workflows/release.yml). It checks that the tag, `package.json`, `Cargo.toml` and the changelog agree, builds, signs the update archive, writes `latest.json` and publishes the release.

Installed apps pick it up within an hour (or right away from **Check for Updates…**), because the app reads `https://github.com/devnonla/hearbridge/releases/latest/download/latest.json`.

- **Pre-releases** (`1.4.0-beta.1`) are published as GitHub pre-releases. GitHub's `latest` link skips them, so installed apps are not offered betas; testers download the `.dmg` by hand.
- **Rebuilding** a release: run the workflow manually (*Actions → Release → Run workflow*) with the existing tag. It replaces the assets of that release.
- **Pulling a bad release**: mark it as a pre-release or delete it on GitHub. `latest` then points at the previous release again. Apps that already updated stay on the bad version until you publish a fixed, higher version.

## One-time setup

### Updater signing key

Every update archive is signed; the app verifies it against the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) and refuses anything else. The maintainer's key pair was made with:

```bash
bun tauri signer generate -w ~/.tauri/hearbridge-updater.key -p "<password>"
```

| File | Where |
| --- | --- |
| private key | `~/.tauri/hearbridge-updater.key` (never commit it; `*.key` is git-ignored) |
| password | `~/.tauri/hearbridge-updater.password` |
| public key | `~/.tauri/hearbridge-updater.key.pub`, copied into `tauri.conf.json` |

Back up the private key and password somewhere safe (a password manager). **If the key is lost, installed apps can never be updated again**: a new key means a new public key in a new build, and people have to download that build by hand.

Add the repository secrets (*Settings → Secrets and variables → Actions*), for example with the GitHub CLI:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo devnonla/hearbridge < ~/.tauri/hearbridge-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo devnonla/hearbridge < ~/.tauri/hearbridge-updater.password
```

The Release workflow stops with an error when `TAURI_SIGNING_PRIVATE_KEY` is missing, because a release without `latest.json` never reaches installed apps.

### Optional: Developer ID signing and notarization

Without these secrets the app is ad-hoc signed and not notarized: first-time users run `xattr -cr /Applications/HearBridge.app` (see the README), and macOS may ask again for Microphone / Screen & System Audio Recording after each update because an ad-hoc signature changes with every build. In-app updates themselves are not blocked by Gatekeeper.

With an Apple Developer account, add these secrets and the same workflow signs and notarizes (Tauri reads them; empty ones are ignored):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the exported *Developer ID Application* `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, an [app-specific password](https://support.apple.com/102654) and the team ID, for notarization |

Once releases are notarized, drop the `xattr` note from the README and from `scripts/updater-manifest.ts`.

## Build locally

```bash
bun run build:app                       # release .app + .dmg in src-tauri/target/aarch64-apple-darwin/release/bundle
bun run build:app -- --archive          # also collect the release files in release/
```

To produce a signed update archive and `latest.json` locally (for testing the updater):

```bash
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/hearbridge-updater.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/hearbridge-updater.password)"
bun run build:app -- --archive
bun scripts/updater-manifest.ts
```

To test an update end to end: build and install version N, then publish N+1 (or serve a `latest.json` and point `plugins.updater.endpoints` at it in a local build). Debug builds (`bun run tauri:dev`) never check on their own and refuse to install updates, so the dev app in `~/Applications/HearBridge Dev.app` is never replaced.

## How the updater works

- `src-tauri/src/updater.rs`: `tauri-plugin-updater` with the key and endpoint from `tauri.conf.json`. Release builds check 15 s after launch and every hour. A newer version is kept in memory and sent to the UI as `update:available`; it is installed only by the `install_update` command (download, verify signature, replace the app, restart), with progress on `update:progress`. Commands: `update_info`, `check_for_updates`, `install_update`.
- `src/hooks/useUpdater.ts`: React hook over those commands and events.
- `src/components/UpdateBanner.tsx`: `UpdateBanner` (available / downloading / installing; asks first while captions are running) and `CheckForUpdatesButton` for settings.
- Forks: change `plugins.updater.pubkey` and `endpoints` in `tauri.conf.json` to your own key and repository, or your builds will offer the official releases.
