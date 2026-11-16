#import "AppleSiriTTS.h"

#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

// Private SiriTTSService (cùng hướng siri-tts-cli): list/speak qua sirittsd,
// không qua AVSpeechSynthesisVoice (API công khai loại Siri Voice).

static void *gSiriHandle = NULL;
static id gSession = nil;      // SiriTTSDaemonSession
static id gActiveRequest = nil; // SiriTTSSpeechRequest
static NSLock *gLock = nil;

static void ensureLock(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{ gLock = [NSLock new]; });
}

static void setErr(char *buf, int32_t len, NSString *msg) {
  if (!buf || len <= 0) return;
  const char *utf = (msg ?: @"error").UTF8String;
  if (!utf) utf = "error";
  strncpy(buf, utf, (size_t)len - 1);
  buf[len - 1] = 0;
}

static BOOL loadFramework(void) {
  if (gSiriHandle) return YES;
  gSiriHandle = dlopen(
    "/System/Library/PrivateFrameworks/SiriTTSService.framework/SiriTTSService",
    RTLD_LAZY | RTLD_LOCAL
  );
  return gSiriHandle != NULL;
}

static id session(void) {
  ensureLock();
  [gLock lock];
  if (!gSession) {
    Class cls = NSClassFromString(@"SiriTTSDaemonSession");
    if (cls) {
      gSession = ((id(*)(id, SEL))objc_msgSend)([cls alloc], @selector(init));
      if ([gSession respondsToSelector:sel_registerName("setKeepActive:")]) {
        ((void(*)(id, SEL, BOOL))objc_msgSend)(
          gSession, sel_registerName("setKeepActive:"), YES
        );
      }
    }
  }
  id s = gSession;
  [gLock unlock];
  return s;
}

static NSString *prettySiriName(NSString *name, NSString *assetKey, NSString *gender) {
  NSString *n = name ?: @"";
  // System catalog dùng vi-VN-C / vi-VN-D (= Voice 3 / 4 trong Settings)
  if ([n isEqualToString:@"vi-VN-C"] || [n.lowercaseString containsString:@"vi-vn-c"]) {
    n = @"Siri Voice 3";
  } else if ([n isEqualToString:@"vi-VN-D"] || [n.lowercaseString containsString:@"vi-vn-d"]) {
    n = @"Siri Voice 4";
  } else if ([n rangeOfString:@"^Voice \\d+$" options:NSRegularExpressionSearch].location != NSNotFound) {
    n = [NSString stringWithFormat:@"Siri %@", n];
  }
  NSMutableArray *bits = [NSMutableArray arrayWithObject:n];
  if ([gender isEqualToString:@"male"]) [bits addObject:@"nam"];
  else if ([gender isEqualToString:@"female"]) [bits addObject:@"nữ"];
  [bits addObject:@"siri"];
  (void)assetKey;
  return [bits componentsJoinedByString:@" · "];
}

static NSString *genderLabel(id voice) {
  id g = [voice valueForKey:@"gender"];
  // 1=male, 2=female (quan sát runtime)
  if ([g respondsToSelector:@selector(intValue)]) {
    int v = [g intValue];
    if (v == 1) return @"male";
    if (v == 2) return @"female";
  }
  NSString *key = [[voice valueForKey:@"assetKey"] description] ?: @"";
  if ([key.lowercaseString containsString:@":male:"]) return @"male";
  if ([key.lowercaseString containsString:@":female:"]) return @"female";
  return @"unknown";
}

static BOOL langMatches(NSString *voiceLang, NSString *want) {
  NSString *a = (voiceLang ?: @"").lowercaseString;
  NSString *b = (want ?: @"").lowercaseString;
  if (b.length == 0 || [b isEqualToString:@"auto"]) return YES;
  NSString *a2 = [a componentsSeparatedByString:@"-u-"].firstObject ?: a;
  if ([a2 hasPrefix:b]) return YES;
  NSString *bp = [b componentsSeparatedByString:@"-"].firstObject ?: b;
  NSString *ap = [a2 componentsSeparatedByString:@"-"].firstObject ?: a2;
  return [ap isEqualToString:bp];
}

static NSString *jsonEscape(NSString *s) {
  NSString *t = s ?: @"";
  t = [t stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
  t = [t stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
  t = [t stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
  return t;
}

int32_t apple_siri_available(void) {
  if (!loadFramework()) return 0;
  return NSClassFromString(@"SiriTTSDaemonSession") != Nil ? 1 : 0;
}

int32_t apple_siri_list_voices(
  const char *lang_bcp47,
  char *out_buf,
  int32_t out_buf_len
) {
  if (!out_buf || out_buf_len < 4) return 1;
  if (!apple_siri_available()) {
    strncpy(out_buf, "[]", (size_t)out_buf_len - 1);
    out_buf[out_buf_len - 1] = 0;
    return 0;
  }
  id sess = session();
  if (!sess) {
    strncpy(out_buf, "[]", (size_t)out_buf_len - 1);
    out_buf[out_buf_len - 1] = 0;
    return 0;
  }

  NSString *want = lang_bcp47 ? [NSString stringWithUTF8String:lang_bcp47] : @"vi";
  if (want.length == 0) want = @"vi";

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSArray *voices = @[];
  ((void(*)(id, SEL, id, id))objc_msgSend)(
    sess,
    sel_registerName("downloadedVoicesMatching:reply:"),
    nil,
    ^(NSArray *list) {
      voices = list ?: @[];
      dispatch_semaphore_signal(sem);
    }
  );
  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)10e9)) != 0) {
    setErr(out_buf, out_buf_len, @"Siri voice list timeout");
    return 2;
  }

  NSMutableArray<NSString *> *rows = [NSMutableArray new];
  for (id v in voices) {
    NSString *lang = [[v valueForKey:@"language"] description] ?: @"";
    if (!langMatches(lang, want)) continue;
    NSString *key = [[v valueForKey:@"assetKey"] description] ?: @"";
    if (key.length == 0) continue;
    NSString *name = [[v valueForKey:@"name"] description] ?: @"Siri";
    NSString *gender = genderLabel(v);
    NSString *label = prettySiriName(name, key, gender);
    [rows addObject:[NSString stringWithFormat:
      @"{\"id\":\"%@\",\"name\":\"%@\",\"lang\":\"%@\",\"gender\":\"%@\",\"quality\":\"siri\"}",
      jsonEscape(key), jsonEscape(label), jsonEscape(lang), jsonEscape(gender)
    ]];
  }

  // Ưu tiên male / Voice 4 trước trong list
  [rows sortUsingComparator:^NSComparisonResult(NSString *a, NSString *b) {
    BOOL a4 = [a containsString:@"Voice 4"] || [a containsString:@"vi-VN-D"];
    BOOL b4 = [b containsString:@"Voice 4"] || [b containsString:@"vi-VN-D"];
    if (a4 != b4) return a4 ? NSOrderedAscending : NSOrderedDescending;
    BOOL am = [a containsString:@"\\\"male\\\""] || [a containsString:@"nam"];
    BOOL bm = [b containsString:@"\\\"male\\\""] || [b containsString:@"nam"];
    if (am != bm) return am ? NSOrderedAscending : NSOrderedDescending;
    return [a compare:b];
  }];

  NSString *json = [NSString stringWithFormat:@"[%@]", [rows componentsJoinedByString:@","]];
  const char *utf = json.UTF8String;
  if (!utf || (int32_t)strlen(utf) >= out_buf_len) {
    setErr(out_buf, out_buf_len, @"Siri voice list quá dài");
    return 3;
  }
  memcpy(out_buf, utf, strlen(utf) + 1);
  return 0;
}

int32_t apple_siri_speak(
  const char *text_utf8,
  const char *voice_asset_key,
  float rate_01,
  float pitch,
  float volume,
  char *err_buf,
  int32_t err_buf_len
) {
  if (!text_utf8 || !voice_asset_key) {
    setErr(err_buf, err_buf_len, @"missing text/voice");
    return 1;
  }
  if (!apple_siri_available()) {
    setErr(err_buf, err_buf_len, @"SiriTTSService không khả dụng");
    return 2;
  }
  id sess = session();
  if (!sess) {
    setErr(err_buf, err_buf_len, @"Không tạo được SiriTTSDaemonSession");
    return 3;
  }

  NSString *text = [NSString stringWithUTF8String:text_utf8];
  NSString *wantKey = [NSString stringWithUTF8String:voice_asset_key];
  text = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (text.length == 0) {
    setErr(err_buf, err_buf_len, @"empty text");
    return 4;
  }

  dispatch_semaphore_t semList = dispatch_semaphore_create(0);
  __block NSArray *voices = @[];
  ((void(*)(id, SEL, id, id))objc_msgSend)(
    sess,
    sel_registerName("downloadedVoicesMatching:reply:"),
    nil,
    ^(NSArray *list) {
      voices = list ?: @[];
      dispatch_semaphore_signal(semList);
    }
  );
  if (dispatch_semaphore_wait(semList, dispatch_time(DISPATCH_TIME_NOW, (int64_t)8e9)) != 0) {
    setErr(err_buf, err_buf_len, @"Siri voice lookup timeout");
    return 5;
  }

  id voice = nil;
  for (id v in voices) {
    NSString *key = [[v valueForKey:@"assetKey"] description] ?: @"";
    if ([key isEqualToString:wantKey]) { voice = v; break; }
  }
  if (!voice) {
    setErr(err_buf, err_buf_len, [NSString stringWithFormat:@"Không tìm thấy Siri voice %@", wantKey]);
    return 6;
  }

  Class Req = NSClassFromString(@"SiriTTSSpeechRequest");
  if (!Req) {
    setErr(err_buf, err_buf_len, @"Thiếu SiriTTSSpeechRequest");
    return 7;
  }
  id req = ((id(*)(id, SEL, id, id))objc_msgSend)(
    [Req alloc],
    sel_registerName("initWithText:voice:"),
    text,
    voice
  );
  if (!req) {
    setErr(err_buf, err_buf_len, @"Không tạo SpeechRequest");
    return 8;
  }

  float r = rate_01;
  if (!(r >= 0.f && r <= 1.f)) r = 0.62f;
  // Map slider AV-style → hệ số Siri (~1.0 = bình thường)
  float siriRate = 0.75f + r * 0.85f;
  float p = pitch;
  if (!(p >= 0.5f && p <= 2.f)) p = 1.f;
  float vol = volume;
  if (!(vol >= 0.f && vol <= 1.f)) vol = 0.45f;

  if ([req respondsToSelector:sel_registerName("setRate:")]) {
    ((void(*)(id, SEL, float))objc_msgSend)(req, sel_registerName("setRate:"), siriRate);
  }
  if ([req respondsToSelector:sel_registerName("setPitch:")]) {
    ((void(*)(id, SEL, float))objc_msgSend)(req, sel_registerName("setPitch:"), p);
  }
  if ([req respondsToSelector:sel_registerName("setVolume:")]) {
    ((void(*)(id, SEL, float))objc_msgSend)(req, sel_registerName("setVolume:"), vol);
  }
  if ([req respondsToSelector:sel_registerName("setPlaybackRate:")]) {
    ((void(*)(id, SEL, float))objc_msgSend)(req, sel_registerName("setPlaybackRate:"), siriRate);
  }
  if ([req respondsToSelector:sel_registerName("setPlaybackVolume:")]) {
    ((void(*)(id, SEL, float))objc_msgSend)(req, sel_registerName("setPlaybackVolume:"), vol);
  }

  ensureLock();
  [gLock lock];
  if (gActiveRequest && [sess respondsToSelector:sel_registerName("cancelWithRequest:")]) {
    ((void(*)(id, SEL, id))objc_msgSend)(sess, sel_registerName("cancelWithRequest:"), gActiveRequest);
  }
  gActiveRequest = req;
  [gLock unlock];

  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  __block NSString *errMsg = nil;
  ((void(*)(id, SEL, id, id))objc_msgSend)(
    sess,
    sel_registerName("speakWithSpeechRequest:didFinish:"),
    req,
    ^(NSError *e) {
      if (e) errMsg = e.localizedDescription ?: @"Siri speak failed";
      ensureLock();
      [gLock lock];
      if (gActiveRequest == req) gActiveRequest = nil;
      [gLock unlock];
      dispatch_semaphore_signal(sem);
    }
  );

  long wait = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)180e9));
  if (wait != 0) {
    apple_siri_stop();
    setErr(err_buf, err_buf_len, @"Siri TTS timeout");
    return 9;
  }
  if (errMsg) {
    setErr(err_buf, err_buf_len, errMsg);
    return 10;
  }
  return 0;
}

void apple_siri_stop(void) {
  if (!apple_siri_available()) return;
  id sess = session();
  ensureLock();
  [gLock lock];
  id req = gActiveRequest;
  gActiveRequest = nil;
  [gLock unlock];
  if (sess && req && [sess respondsToSelector:sel_registerName("cancelWithRequest:")]) {
    ((void(*)(id, SEL, id))objc_msgSend)(sess, sel_registerName("cancelWithRequest:"), req);
  }
}
