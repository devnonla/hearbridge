#!/usr/bin/env bash
# Cargo runner cho `tauri:dev` trên macOS.
#
# TCC (Screen/Audio/Speech) gắn theo code requirement. Ký adhoc + --force mỗi lần
# launch → "Failed to match existing code requirement" → hỏi permission lại.
# Cách xử lý: app ổn định ở ~/Applications, chỉ resign khi binary đổi,
# ưu tiên Developer ID / Apple Development (Team ID).
if [ -z "${BASH_VERSION:-}" ]; then
  exec /usr/bin/env bash "$0" "$@"
fi

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: macos-dev-app-runner.sh <binary> [args...]" >&2
  exit 64
fi

binary="$1"
shift
app_args=("$@")

if [ ! -f "$binary" ]; then
  echo "binary not found: $binary" >&2
  exit 66
fi

base="$(basename "$binary")"
if [ "$base" != "hearbridge" ]; then
  exec "$binary" "${app_args[@]}"
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
# Đường dẫn ổn định — TCC/LaunchServices nhớ đúng một app
bundle_dir="${HEARBRIDGE_DEV_APP_BUNDLE:-$HOME/Applications/HearBridge Dev.app}"
contents_dir="$bundle_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
bundle_executable="$macos_dir/hearbridge"
hash_file="$contents_dir/.hearbridge-binary-sha256"

mkdir -p "$macos_dir" "$resources_dir" "$HOME/Applications"

new_hash="$(shasum -a 256 "$binary" | awk '{print $1}')"
old_hash=""
if [ -f "$hash_file" ]; then
  old_hash="$(cat "$hash_file" 2>/dev/null || true)"
fi

need_copy=1
if [ -f "$bundle_executable" ] && [ "$new_hash" = "$old_hash" ]; then
  need_copy=0
  echo "▸ Binary không đổi — giữ chữ ký cũ (tránh hỏi lại Screen Recording)"
fi

if [ "$need_copy" -eq 1 ]; then
  cp "$binary" "$bundle_executable"
  chmod +x "$bundle_executable"
  printf '%s\n' "$new_hash" >"$hash_file"
fi

# Plist đầy đủ identity + privacy keys
cat >"$contents_dir/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>hearbridge</string>
	<key>CFBundleIdentifier</key>
	<string>com.quypv.hearbridge.dev</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>HearBridge Dev</string>
	<key>CFBundleDisplayName</key>
	<string>HearBridge Dev</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.0.0-dev</string>
	<key>CFBundleVersion</key>
	<string>0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSMicrophoneUsageDescription</key>
	<string>HearBridge cần micro để bạn nói và đồng dịch trong cuộc họp.</string>
	<key>NSAudioCaptureUsageDescription</key>
	<string>HearBridge cần bắt system audio để nghe người kia trong Zoom/Meet/livestream và hiện phụ đề.</string>
	<key>NSScreenCaptureUsageDescription</key>
	<string>HearBridge cần quyền Screen và System Audio Recording để bắt tiếng hệ thống (không ghi hình).</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>HearBridge nhận diện tiếng Anh on-device từ system audio để hiện phụ đề nhanh.</string>
	<key>NSAppleEventsUsageDescription</key>
	<string>HearBridge cần quyền hệ thống để bắt audio cuộc họp.</string>
</dict>
</plist>
PLIST

if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$bundle_dir" 2>/dev/null || true
fi

pick_codesign_identity() {
  if [ -n "${HEARBRIDGE_CODESIGN_IDENTITY:-}" ]; then
    printf '%s\n' "$HEARBRIDGE_CODESIGN_IDENTITY"
    return
  fi
  local id
  # Developer ID bền với TCC Screen Recording hơn adhoc / đôi khi hơn Apple Development
  id="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
    | head -1)"
  if [ -n "$id" ]; then
    printf '%s\n' "$id"
    return
  fi
  id="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' \
    | head -1)"
  if [ -n "$id" ]; then
    printf '%s\n' "$id"
    return
  fi
  printf '%s\n' "-"
}

if [ "$need_copy" -eq 1 ] && command -v codesign >/dev/null 2>&1; then
  identity="$(pick_codesign_identity)"
  echo "▸ Signing $bundle_dir ($identity)"
  sign_args=(--force --deep --sign "$identity" --identifier com.quypv.hearbridge.dev)
  if [ -f "$repo_root/src-tauri/Entitlements.plist" ]; then
    sign_args+=(--entitlements "$repo_root/src-tauri/Entitlements.plist")
  fi
  if [[ "$identity" == "-" ]]; then
    codesign "${sign_args[@]}" "$bundle_dir"
  else
    # Hardened runtime giúp designated requirement ổn định hơn với Developer ID
    codesign "${sign_args[@]}" --options runtime --timestamp=none "$bundle_dir" 2>/dev/null \
      || codesign "${sign_args[@]}" "$bundle_dir"
  fi
  codesign -dv --verbose=2 "$bundle_dir" 2>&1 | rg -i "Authority|TeamIdentifier|Identifier" || true
fi

# Kill instance cũ cùng bundle
pkill -f "Applications/HearBridge Dev.app/Contents/MacOS/hearbridge" 2>/dev/null || true
sleep 0.2

if [ ! -x "$bundle_executable" ]; then
  echo "▸ Executable thiếu: $bundle_executable — copy lại" >&2
  cp "$binary" "$bundle_executable"
  chmod +x "$bundle_executable"
  printf '%s\n' "$new_hash" >"$hash_file"
fi

/usr/bin/codesign --verify --deep --strict "$bundle_dir" 2>&1 | sed 's/^/▸ verify: /' || true

export RUST_BACKTRACE="${RUST_BACKTRACE:-1}"
env_args=()
while IFS= read -r line; do
  key="${line%%=*}"
  case "$key" in
    TAURI_*|RUST_*|VITE_*|CI|TERM|COLORTERM|PATH|HOME|USER|TMPDIR|LANG|LC_*)
      env_args+=(--env "$line")
      ;;
  esac
done < <(env)

# stdout/stderr của app (panic Rust, lỗi Swift/C++) → file log, vì `open` không nối vào terminal.
log_dir="$HOME/Library/Logs/HearBridge"
mkdir -p "$log_dir"
app_log="$log_dir/dev.log"
: >"$app_log"
echo "▸ Launching $bundle_dir via Launch Services (log: $app_log)"
# open PATH.app (không dùng -a) để tránh LS nhầm bản cũ trong target/debug
open_cmd=(open -n --stdout "$app_log" --stderr "$app_log" "$bundle_dir")
if [ "${#env_args[@]}" -gt 0 ]; then
  open_cmd+=("${env_args[@]}")
fi
if [ "${#app_args[@]}" -gt 0 ]; then
  open_cmd+=(--args "${app_args[@]}")
fi
"${open_cmd[@]}"

# Chờ process app
app_pid=""
for _ in $(seq 1 80); do
  app_pid="$(pgrep -nf "Applications/HearBridge Dev.app/Contents/MacOS/hearbridge" || true)"
  if [ -n "$app_pid" ]; then
    break
  fi
  sleep 0.1
done
if [ -z "$app_pid" ]; then
  echo "▸ App không start được: $bundle_dir" >&2
  ls -la "$macos_dir" >&2 || true
  exit 1
fi
echo "▸ App PID $app_pid — đang chạy (giữ cargo/tauri:dev)"

cleanup() {
  if [ -n "${app_pid:-}" ] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM

while kill -0 "$app_pid" 2>/dev/null; do
  sleep 1
done
exit 0
