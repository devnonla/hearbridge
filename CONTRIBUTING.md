# Contributing to HearBridge

Thanks for your interest in HearBridge! Bug reports, ideas, docs fixes and pull requests are all welcome.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open an [issue](../../issues/new/choose) with steps to reproduce, your macOS version and chip.
- **Suggest a feature** — open a feature request first so we can agree on scope before you write code.
- **Fix something** — pick an issue (look for `good first issue` / `help wanted`) and comment that you're on it.
- **Security issues** — do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requirements: macOS 14+ (Apple Silicon recommended), [Bun](https://bun.sh), [Rust](https://rustup.rs) (stable), Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/devnonla/hearbridge.git
cd hearbridge
bun install
bun run tauri:dev
```

On first launch open **Settings** and paste your [OpenRouter](https://openrouter.ai) API key. Keys are stored locally in `~/Library/Application Support/hearbridge/settings.json` — never commit keys or personal data.

The Rust build compiles the native Apple bridge in `src-tauri/native/` automatically (`build.rs`); the resulting `libapple_listen.a` is git-ignored.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/` | React + TypeScript UI (Tailwind, shadcn/ui) |
| `src-tauri/src/` | Rust backend (OpenRouter client, settings, audio) |
| `src-tauri/native/` | Objective-C / Swift bridge to Apple Speech, TTS, Translation, ScreenCaptureKit |
| `scripts/` | Dev runner, build / release / version scripts |
| `docs/` | Maintainer docs ([RELEASING.md](docs/RELEASING.md)) |

## Before you open a pull request

Run the same checks CI runs:

```bash
bun run build                                   # tsc + vite build
bun run version:check                           # package.json and Cargo.toml versions agree
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```

Then:

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep the PR focused — one logical change per PR.
3. Update `README.md` / `CHANGELOG.md` (under **Unreleased**) when behaviour changes.
4. Include screenshots or a short recording for UI changes.
5. Fill in the PR template.

## Commit messages

Use short, imperative [Conventional Commits](https://www.conventionalcommits.org/) style:

```
feat: add SRT export for captions
fix: keep captions visible when window loses focus
docs: clarify BlackHole setup
```

## Code style

- TypeScript: strict mode, functional React components, Tailwind utility classes.
- Rust: `cargo fmt` defaults, no `clippy` warnings, return `Result` instead of panicking in app code.
- Editor settings live in [.editorconfig](.editorconfig).

## Releasing (maintainers)

Full guide: [docs/RELEASING.md](docs/RELEASING.md). In short:

1. Put the release notes under `## [Unreleased]` in `CHANGELOG.md` (they become the GitHub release body and the in-app update notes).
2. On a clean `main`: `bun run release patch` (or `minor`, `major`, `x.y.z`, `x.y.z-beta.N`). It syncs the version in `package.json`, `src-tauri/Cargo.toml` and `Cargo.lock` (`tauri.conf.json` reads `package.json`), rolls the changelog, checks the build, commits `chore: release vX.Y.Z` and tags `vX.Y.Z`.
3. `git push origin main && git push origin vX.Y.Z`. The [Release workflow](.github/workflows/release.yml) builds the Apple Silicon `.dmg` and the signed update archive, writes `latest.json` and publishes the release; installed apps offer the update within an hour.

The workflow needs the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets (updater signing key). Builds are ad-hoc signed and not notarized unless the optional `APPLE_*` secrets are set. Never commit signing keys.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
