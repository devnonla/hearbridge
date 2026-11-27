#!/usr/bin/env bash
# HearBridge one-line installer for macOS (Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/devnonla/hearbridge/main/scripts/install.sh | bash
#
# Downloads the latest release .dmg from GitHub, copies HearBridge.app into
# /Applications (or ~/Applications when /Applications isn't writable), removes the
# download quarantine flag (the app is open source and not notarized yet) and opens it.
#
# Options (environment variables):
#   HEARBRIDGE_VERSION=0.2.0   install that version instead of the latest
#   HEARBRIDGE_DRY_RUN=1       only print what would happen

set -euo pipefail

REPO="devnonla/hearbridge"
APP_NAME="HearBridge.app"
DRY_RUN="${HEARBRIDGE_DRY_RUN:-0}"

say() { printf '\033[1;38;5;208m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "  (dry run) $*"; else "$@"; fi; }

# ── Checks ────────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "HearBridge chỉ chạy trên macOS."
[ "$(uname -m)" = "arm64" ] || die "HearBridge hiện chỉ có bản cho Mac Apple Silicon (M1 trở lên)."
os="$(sw_vers -productVersion)"
os_major="${os%%.*}"
os_minor="$(echo "$os" | cut -d. -f2)"
if [ "$os_major" -lt 14 ] || { [ "$os_major" -eq 14 ] && [ "${os_minor:-0}" -lt 4 ]; }; then
  die "Cần macOS 14.4 trở lên (máy đang là $os)."
fi

# ── Find the .dmg ─────────────────────────────────────────────────────────
if [ -n "${HEARBRIDGE_VERSION:-}" ]; then
  api="https://api.github.com/repos/$REPO/releases/tags/v${HEARBRIDGE_VERSION#v}"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
fi
say "Đang tìm bản phát hành…"
dmg_url="$(curl -fsSL "$api" | grep -o '"browser_download_url": *"[^"]*_aarch64\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"$/\1/')"
[ -n "$dmg_url" ] || die "Không tìm thấy file .dmg trong bản phát hành ($api)."
say "Bản tải: ${dmg_url##*/}"

# ── Download + mount ──────────────────────────────────────────────────────
tmp="$(mktemp -d)"
mnt=""
cleanup() {
  if [ -n "$mnt" ]; then hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT

if [ "$DRY_RUN" = "1" ]; then
  echo "  (dry run) curl -fL $dmg_url -o $tmp/HearBridge.dmg"
  src="(mounted dmg)/$APP_NAME"
else
  say "Đang tải…"
  curl -fL --progress-bar "$dmg_url" -o "$tmp/HearBridge.dmg"
  mnt="$tmp/mnt"
  mkdir -p "$mnt"
  hdiutil attach "$tmp/HearBridge.dmg" -nobrowse -readonly -mountpoint "$mnt" -quiet
  src="$mnt/$APP_NAME"
  [ -d "$src" ] || die "Trong .dmg không có $APP_NAME."
fi

# ── Install ───────────────────────────────────────────────────────────────
dest_dir="/Applications"
if [ ! -w "$dest_dir" ]; then
  dest_dir="$HOME/Applications"
  run mkdir -p "$dest_dir"
fi
dest="$dest_dir/$APP_NAME"

if pgrep -x HearBridge >/dev/null 2>&1 || pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; then
  say "Đang đóng HearBridge cũ…"
  run osascript -e 'tell application "HearBridge" to quit' >/dev/null 2>&1 || true
  run sleep 2
fi

say "Cài vào $dest_dir"
run rm -rf "$dest"
run ditto "$src" "$dest"
# Not notarized yet: drop the quarantine flag so Gatekeeper doesn't call it "damaged".
run xattr -cr "$dest"

say "Xong. Đang mở HearBridge…"
run open "$dest"

cat <<'TXT'

Lần đầu mở, hãy cho phép khi macOS hỏi:
  • Micro, Nhận dạng giọng nói, Ghi màn hình & âm thanh hệ thống
  • Để nhận giọng tiếng Việt của bạn: Cài đặt hệ thống › Bàn phím › Đọc chính tả → Bật, thêm Tiếng Việt
Hướng dẫn đầy đủ: https://github.com/devnonla/hearbridge#install
TXT
