#!/usr/bin/env bash
# Build Process Tap (ObjC) + Apple TTS (Swift AVSpeech) + SiriTTS (private ObjC)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$ROOT/libapple_listen.a}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SDK="$(xcrun --sdk macosx --show-sdk-path)"
TARGET="arm64-apple-macos14.4"

clang -c \
  -isysroot "$SDK" \
  -target "$TARGET" \
  -fobjc-arc \
  -O2 \
  -I"$ROOT" \
  -o "$TMP/AppleListen.o" \
  "$ROOT/AppleListen.m"

clang -c \
  -isysroot "$SDK" \
  -target "$TARGET" \
  -fobjc-arc \
  -O2 \
  -I"$ROOT" \
  -o "$TMP/AppleApps.o" \
  "$ROOT/AppleApps.m"

clang -c \
  -isysroot "$SDK" \
  -target "$TARGET" \
  -fobjc-arc \
  -O2 \
  -I"$ROOT" \
  -o "$TMP/AppleSiriTTS.o" \
  "$ROOT/AppleSiriTTS.m"

# Swift TTS: AVSpeech + gọi C API Siri
xcrun swiftc -c \
  -sdk "$SDK" \
  -target "$TARGET" \
  -O \
  -parse-as-library \
  -import-objc-header "$ROOT/AppleSpeak.h" \
  -I"$ROOT" \
  -o "$TMP/AppleSpeak.o" \
  "$ROOT/AppleSpeak.swift"

# Apple Translation (SwiftUI TranslationSession) — cần macOS 15+
xcrun swiftc -c \
  -sdk "$SDK" \
  -target "arm64-apple-macos15.0" \
  -O \
  -parse-as-library \
  -framework Translation \
  -framework SwiftUI \
  -framework AppKit \
  -o "$TMP/AppleTranslate.o" \
  "$ROOT/AppleTranslate.swift" || {
  echo "warn: AppleTranslate.swift build failed — dịch sẽ fallback OpenRouter" >&2
  # stub object so link still works
  cat > "$TMP/AppleTranslateStub.c" <<'C'
#include <stdint.h>
int32_t apple_translate(const char *a, const char *b, const char *c, char *d, int32_t e, char *f, int32_t g) {
  (void)a;(void)b;(void)c;(void)d;(void)e;
  if (f && g > 0) { f[0]='u';f[1]='n';f[2]='a';f[3]='v';f[4]='a';f[5]='i';f[6]='l';f[7]=0; }
  return 1;
}
int32_t apple_translate_status(const char *a, const char *b, char *c, int32_t d) {
  (void)a;(void)b;
  if (c && d > 0) { c[0]='u';c[1]='n';c[2]='s';c[3]='u';c[4]='p';c[5]='p';c[6]=0; }
  return 0;
}
C
  clang -c -isysroot "$SDK" -target "$TARGET" -O2 -o "$TMP/AppleTranslate.o" "$TMP/AppleTranslateStub.c"
}

libtool -static -o "$OUT" \
  "$TMP/AppleListen.o" \
  "$TMP/AppleSpeak.o" \
  "$TMP/AppleApps.o" \
  "$TMP/AppleSiriTTS.o" \
  "$TMP/AppleTranslate.o"
echo "built $OUT (listen+apps+siri+speak+translate)"
