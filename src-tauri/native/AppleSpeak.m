#import "AppleSpeak.h"
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <string.h>

static const void *kCicadaTtsTokenKey = &kCicadaTtsTokenKey;

@interface CTSpeaker : NSObject <AVSpeechSynthesizerDelegate>
- (BOOL)speak:(NSString *)text
         lang:(NSString *)lang
      voiceId:(NSString *)voiceId
        rate01:(float)rate01
        pitch:(float)pitch
       volume:(float)volume
        error:(NSString **)error;
- (void)stop;
@end

static CTSpeaker *gSpeaker = nil;
static AVSpeechSynthesisVoice *gCachedVoice = nil;
static NSString *gCachedKey = nil;

static void setErr(char *buf, int32_t len, NSString *msg) {
  if (!buf || len <= 0) return;
  const char *c = msg.UTF8String ?: "error";
  strncpy(buf, c, (size_t)len - 1);
  buf[len - 1] = 0;
}

static NSString *normalizeLang(const char *lang_bcp47) {
  if (!lang_bcp47 || !*lang_bcp47) return @"en-US";
  NSString *raw = [[NSString stringWithUTF8String:lang_bcp47] lowercaseString];
  if ([raw hasPrefix:@"vi"]) return @"vi-VN";
  if ([raw hasPrefix:@"zh"]) return @"zh-CN";
  if ([raw hasPrefix:@"ja"]) return @"ja-JP";
  if ([raw hasPrefix:@"ko"]) return @"ko-KR";
  if ([raw hasPrefix:@"fr"]) return @"fr-FR";
  if ([raw hasPrefix:@"de"]) return @"de-DE";
  if ([raw hasPrefix:@"es"]) return @"es-ES";
  if ([raw hasPrefix:@"en"]) return @"en-US";
  if ([raw containsString:@"-"]) {
    NSArray *parts = [raw componentsSeparatedByString:@"-"];
    if (parts.count >= 2) {
      return [NSString stringWithFormat:@"%@-%@", parts[0], [parts[1] uppercaseString]];
    }
  }
  return @"en-US";
}

static BOOL langMatches(NSString *voiceLang, NSString *wantLang) {
  NSString *want = [[[wantLang componentsSeparatedByString:@"-"] firstObject] lowercaseString];
  NSString *have = [[[voiceLang componentsSeparatedByString:@"-"] firstObject] lowercaseString];
  return [want isEqualToString:have];
}

static BOOL isNoveltyVoice(AVSpeechSynthesisVoice *v) {
  NSString *id = v.identifier.lowercaseString ?: @"";
  NSString *name = v.name.lowercaseString ?: @"";
  // Novelty / effect voices — nghe như đồ chơi
  NSArray *bad = @[
    @"zarvox", @"trinoids", @"boing", @"bubbles", @"bells", @"cellos", @"organ",
    @"deranged", @"hysterical", @"badnews", @"goodnews", @"whisper", @"bahh",
    @"princess", @"jester", @"wobble", @"albert", @"ralph", @"junior", @"kathy",
    @"fred", @"eloquence"
  ];
  for (NSString *b in bad) {
    if ([id containsString:b] || [name containsString:b]) return YES;
  }
  return NO;
}

static NSInteger voiceScore(AVSpeechSynthesisVoice *v, NSString *lang) {
  if (!langMatches(v.language, lang)) return -100000;
  if (isNoveltyVoice(v)) return -50000;

  NSInteger score = 0;
  NSString *ident = v.identifier.lowercaseString ?: @"";
  NSString *name = v.name.lowercaseString ?: @"";

  // Ưu tiên giọng nam khi máy có (VI hiện Apple thường chỉ ship Linh nữ)
  if (@available(macOS 10.15, *)) {
    if (v.gender == AVSpeechSynthesisVoiceGenderMale) score += 9000;
    else if (v.gender == AVSpeechSynthesisVoiceGenderFemale) score += 500;
  }
  // Tên hay gặp giọng nam (khi gender API không báo)
  NSArray *maleHints = @[
    @"aaron", @"daniel", @"alex", @"tom", @"nathan", @"oliver", @"reed",
    @"rocko", @"eddy", @"rishi", @"aman", @"fred", @"grandpa", @"quan", @"minh"
  ];
  for (NSString *h in maleHints) {
    if ([ident containsString:h] || [name containsString:h]) {
      score += 2500;
      break;
    }
  }

  // Chất lượng: Premium > Enhanced ≫ default ≫ compact (compact dễ vang/gắt)
  if (@available(macOS 13.0, *)) {
    if (v.quality == AVSpeechSynthesisVoiceQualityPremium) score += 20000;
    else if (v.quality == AVSpeechSynthesisVoiceQualityEnhanced) score += 15000;
    else score += 500;
  }

  if ([ident containsString:@"super-compact"]) score -= 22000;
  else if ([ident containsString:@"compact"]) score -= 14000;
  if ([ident containsString:@"siri.natural"] || [ident containsString:@"neural"]) score += 8000;
  if ([ident containsString:@"premium"]) score += 6000;
  else if ([ident containsString:@"enhanced"]) score += 5000;

  if ([lang hasPrefix:@"vi"]) {
    // Neural Voice 3/4 (System Voices) > Linh enhanced > Linh compact
    if ([ident containsString:@"gryphon"] || [ident containsString:@"ttsbundle"]) score += 12000;
    if ([name isEqualToString:@"voice 4"] || [ident containsString:@"vi-vn-d_"]) score += 8000; // nam
    if ([name isEqualToString:@"voice 3"] || [ident containsString:@"vi-vn-c_"]) score += 5000;
    if ([name containsString:@"linh"]) score += 1500;
    if ([ident containsString:@"enhanced"] || [ident containsString:@"premium"]) score += 4000;
  }
  if ([lang hasPrefix:@"en"]) {
    // Aaron (Siri natural) = nam, rõ, ít “đồ chơi”
    if ([ident containsString:@"aaron"] || [name containsString:@"voice 1"]) score += 4000;
  }

  // Locale khớp đầy đủ (vi-VN vs vi)
  if ([v.language.lowercaseString isEqualToString:lang.lowercaseString]) score += 100;

  return score;
}

static AVSpeechSynthesisVoice *voiceByIdOnMain(NSString *voiceId) {
  if (voiceId.length == 0) return nil;
  for (AVSpeechSynthesisVoice *v in [AVSpeechSynthesisVoice speechVoices]) {
    if ([v.identifier isEqualToString:voiceId]) return v;
  }
  return nil;
}

/// Chỉ gọi trên main — TextToSpeech/AX lock không thread-safe.
static AVSpeechSynthesisVoice *bestVoiceOnMain(NSString *lang, NSString *preferredId) {
  NSCAssert([NSThread isMainThread], @"bestVoiceOnMain must run on main");
  NSString *cacheKey = [NSString stringWithFormat:@"%@|%@", lang, preferredId ?: @""];
  if (gCachedVoice && [gCachedKey isEqualToString:cacheKey]) {
    return gCachedVoice;
  }

  AVSpeechSynthesisVoice *best = voiceByIdOnMain(preferredId);
  // Preferred phải cùng họ ngôn ngữ (vi* / en*)
  if (best && !langMatches(best.language, lang)) best = nil;
  if (!best) {
    NSInteger bestScore = NSIntegerMin;
    for (AVSpeechSynthesisVoice *v in [AVSpeechSynthesisVoice speechVoices]) {
      NSInteger s = voiceScore(v, lang);
      if (s > bestScore) {
        bestScore = s;
        best = v;
      }
    }
  }
  if (!best) {
    best = [AVSpeechSynthesisVoice voiceWithLanguage:lang]
        ?: [AVSpeechSynthesisVoice voiceWithLanguage:@"en-US"];
  }
  gCachedVoice = best;
  gCachedKey = [cacheKey copy];
  NSLog(@"[AppleSpeak] pick voice=%@ id=%@ lang=%@ preferred=%@",
        best.name, best.identifier, lang, preferredId ?: @"(auto)");
  return best;
}

static NSString *genderLabel(AVSpeechSynthesisVoice *v) {
  if (@available(macOS 10.15, *)) {
    switch (v.gender) {
      case AVSpeechSynthesisVoiceGenderMale: return @"male";
      case AVSpeechSynthesisVoiceGenderFemale: return @"female";
      default: break;
    }
  }
  return @"unknown";
}

static NSString *qualityLabel(AVSpeechSynthesisVoice *v) {
  if (@available(macOS 13.0, *)) {
    switch (v.quality) {
      case AVSpeechSynthesisVoiceQualityPremium: return @"premium";
      case AVSpeechSynthesisVoiceQualityEnhanced: return @"enhanced";
      default: break;
    }
  }
  NSString *id = v.identifier.lowercaseString ?: @"";
  if ([id containsString:@"premium"] || [id containsString:@"gryphon"] || [id containsString:@"neural"]) {
    return @"premium";
  }
  if ([id containsString:@"enhanced"]) return @"enhanced";
  if ([id containsString:@"compact"]) return @"compact";
  return @"default";
}

@implementation CTSpeaker {
  AVSpeechSynthesizer *_synth;
  dispatch_semaphore_t _done;
  NSUInteger _token;
  BOOL _ok;
  NSString *_err;
}

- (instancetype)init {
  self = [super init];
  if (!self) return nil;
  NSCAssert([NSThread isMainThread], @"CTSpeaker must be created on main");
  _synth = [AVSpeechSynthesizer new];
  _synth.delegate = self;
  _token = 0;
  return self;
}

- (void)signalDoneIfNeeded {
  if (!_done) return;
  dispatch_semaphore_t sem = _done;
  _done = nil;
  dispatch_semaphore_signal(sem);
}

- (void)startUtteranceOnMain:(NSString *)trimmed
                        lang:(NSString *)lang
                     voiceId:(NSString *)voiceId
                      rate01:(float)rate01
                       pitch:(float)pitch
                      volume:(float)volume
                        done:(dispatch_semaphore_t)done {
  NSCAssert([NSThread isMainThread], @"startUtteranceOnMain");
  _token += 1;
  NSUInteger myToken = _token;
  _ok = YES;
  _err = nil;

  [self signalDoneIfNeeded];
  _done = done;

  // Chỉ dừng nếu đang nói — tránh cancel/race làm câu 2 không bao giờ didFinish
  if (_synth.isSpeaking) {
    [_synth stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }

  AVSpeechUtterance *u = [AVSpeechUtterance speechUtteranceWithString:trimmed];
  AVSpeechSynthesisVoice *voice = bestVoiceOnMain(lang, voiceId);
  u.voice = voice;

  // Rate/pitch/volume từ settings UI (chỉ Apple TTS).
  float t = rate01;
  if (!(t >= 0.f) || t > 1.f) t = 0.62f;
  float minR = AVSpeechUtteranceMinimumSpeechRate;
  float maxR = AVSpeechUtteranceMaximumSpeechRate;
  u.rate = minR + (maxR - minR) * t;

  float p = pitch;
  if (!(p >= 0.5f) || p > 2.f) p = 1.f;
  u.pitchMultiplier = p;

  float vol = volume;
  if (!(vol >= 0.f) || vol > 1.f) vol = 0.45f;
  u.volume = vol;

  u.preUtteranceDelay = 0.0;
  u.postUtteranceDelay = 0.02;

  objc_setAssociatedObject(u, kCicadaTtsTokenKey, @(myToken), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  NSLog(@"[AppleSpeak] speak voice=%@ rate=%.3f pitch=%.2f vol=%.2f text=%@",
        voice.name, u.rate, u.pitchMultiplier, u.volume, trimmed);
  [_synth speakUtterance:u];
}

- (BOOL)speak:(NSString *)text
         lang:(NSString *)lang
      voiceId:(NSString *)voiceId
       rate01:(float)rate01
        pitch:(float)pitch
       volume:(float)volume
        error:(NSString **)error {
  NSString *trimmed = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (trimmed.length == 0) {
    if (error) *error = @"empty text";
    return NO;
  }

  dispatch_semaphore_t done = dispatch_semaphore_create(0);

  if ([NSThread isMainThread]) {
    [self startUtteranceOnMain:trimmed lang:lang voiceId:voiceId rate01:rate01 pitch:pitch volume:volume done:done];
  } else {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self startUtteranceOnMain:trimmed lang:lang voiceId:voiceId rate01:rate01 pitch:pitch volume:volume done:done];
    });
  }

  // Chờ didFinish/didCancel. Không wait NOW rồi wait timed — lần timed đã
  //consume signal khiến vòng sau kẹt đến timeout (chỉ nghe được câu 1).
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:180];
  for (;;) {
    if (dispatch_semaphore_wait(done, DISPATCH_TIME_NOW) == 0) break;
    if ([deadline timeIntervalSinceNow] < 0) {
      [self stop];
      if (error) *error = @"TTS timeout";
      return NO;
    }
    if ([NSThread isMainThread]) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    } else {
      long got = dispatch_semaphore_wait(
          done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)50 * NSEC_PER_MSEC));
      if (got == 0) break;
    }
  }

  if (!_ok) {
    if (error) *error = _err ?: @"TTS failed";
    return NO;
  }
  return YES;
}

- (void)stop {
  void (^block)(void) = ^{
    self->_token += 1;
    [self->_synth stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
    self->_ok = YES;
    [self signalDoneIfNeeded];
  };
  if ([NSThread isMainThread]) {
    block();
  } else {
    dispatch_sync(dispatch_get_main_queue(), block);
  }
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didFinishSpeechUtterance:(AVSpeechUtterance *)utterance {
  (void)synthesizer;
  NSNumber *tok = objc_getAssociatedObject(utterance, kCicadaTtsTokenKey);
  if (tok && tok.unsignedIntegerValue == _token) {
    _ok = YES;
    [self signalDoneIfNeeded];
  }
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer didCancelSpeechUtterance:(AVSpeechUtterance *)utterance {
  (void)synthesizer;
  // Nếu bị cancel mà vẫn là utterance hiện tại → mở semaphore (tránh kẹt / nuốt câu sau)
  NSNumber *tok = objc_getAssociatedObject(utterance, kCicadaTtsTokenKey);
  if (tok && tok.unsignedIntegerValue == _token) {
    _ok = YES;
    [self signalDoneIfNeeded];
  }
}

@end

static void ensureSpeakerOnMain(void) {
  NSCAssert([NSThread isMainThread], @"ensureSpeakerOnMain");
  if (!gSpeaker) {
    gSpeaker = [CTSpeaker new];
  }
}

int32_t apple_speak(const char *text_utf8,
                    const char *lang_bcp47,
                    const char *voice_id_utf8,
                    float rate_01,
                    float pitch,
                    float volume,
                    char *err_buf,
                    int32_t err_buf_len) {
  if (!text_utf8) {
    setErr(err_buf, err_buf_len, @"missing text");
    return 1;
  }
  NSString *text = [NSString stringWithUTF8String:text_utf8];
  NSString *lang = normalizeLang(lang_bcp47);
  NSString *voiceId = nil;
  if (voice_id_utf8 && *voice_id_utf8) {
    voiceId = [NSString stringWithUTF8String:voice_id_utf8];
  }

  if ([NSThread isMainThread]) {
    ensureSpeakerOnMain();
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{ ensureSpeakerOnMain(); });
  }

  NSString *err = nil;
  BOOL ok = [gSpeaker speak:text
                       lang:lang
                    voiceId:voiceId
                     rate01:rate_01
                      pitch:pitch
                     volume:volume
                      error:&err];
  if (!ok) {
    setErr(err_buf, err_buf_len, err ?: @"speak failed");
    return 2;
  }
  return 0;
}

static NSString *jsonEscape(NSString *s) {
  if (!s) return @"";
  NSMutableString *o = [NSMutableString stringWithString:s];
  [o replaceOccurrencesOfString:@"\\" withString:@"\\\\" options:0 range:NSMakeRange(0, o.length)];
  [o replaceOccurrencesOfString:@"\"" withString:@"\\\"" options:0 range:NSMakeRange(0, o.length)];
  [o replaceOccurrencesOfString:@"\n" withString:@"\\n" options:0 range:NSMakeRange(0, o.length)];
  return o;
}

int32_t apple_speak_list_voices(const char *lang_bcp47, char *out_buf, int32_t out_buf_len) {
  if (!out_buf || out_buf_len < 4) return 1;
  NSString *lang = normalizeLang(lang_bcp47);

  __block NSMutableArray<NSString *> *items = [NSMutableArray new];
  void (^collect)(void) = ^{
    // Gộp compact/enhanced cùng tên (vd. Linh) — chỉ giữ bản chất lượng cao nhất.
    NSMutableDictionary<NSString *, AVSpeechSynthesisVoice *> *bestByKey = [NSMutableDictionary new];
    NSMutableDictionary<NSString *, NSNumber *> *scoreByKey = [NSMutableDictionary new];
    for (AVSpeechSynthesisVoice *v in [AVSpeechSynthesisVoice speechVoices]) {
      if (isNoveltyVoice(v)) continue;
      if (!langMatches(v.language, lang)) continue;
      NSString *vid = v.identifier.lowercaseString ?: @"";
      if ([vid containsString:@"super-compact"]) continue;

      NSString *rawName = v.name ?: @"Voice";
      NSString *base = [[rawName stringByReplacingOccurrencesOfString:@" (Enhanced)" withString:@""]
                        stringByReplacingOccurrencesOfString:@" (Premium)" withString:@""];
      base = [base stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      NSString *g = genderLabel(v);
      NSString *key = [NSString stringWithFormat:@"%@|%@", base.lowercaseString, g];

      NSInteger s = voiceScore(v, lang);
      NSNumber *prev = scoreByKey[key];
      if (prev && prev.integerValue >= s) continue;
      bestByKey[key] = v;
      scoreByKey[key] = @(s);
    }

    NSArray<AVSpeechSynthesisVoice *> *matched =
      [bestByKey.allValues sortedArrayUsingComparator:^NSComparisonResult(AVSpeechSynthesisVoice *a, AVSpeechSynthesisVoice *b) {
        NSInteger sa = voiceScore(a, lang);
        NSInteger sb = voiceScore(b, lang);
        if (sa > sb) return NSOrderedAscending;
        if (sa < sb) return NSOrderedDescending;
        return [a.name compare:b.name];
      }];

    for (AVSpeechSynthesisVoice *v in matched) {
      NSString *rawName = v.name ?: @"Voice";
      NSString *label = [[rawName stringByReplacingOccurrencesOfString:@" (Enhanced)" withString:@""]
                         stringByReplacingOccurrencesOfString:@" (Premium)" withString:@""];
      label = [label stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      NSString *q = qualityLabel(v);
      NSString *g = genderLabel(v);
      // "Voice 4 · nam · premium" / "Linh · nữ · enhanced"
      NSString *gVi = [g isEqualToString:@"male"] ? @"nam" : ([g isEqualToString:@"female"] ? @"nữ" : @"");
      NSMutableArray *bits = [NSMutableArray new];
      [bits addObject:label];
      if (gVi.length) [bits addObject:gVi];
      if (q.length && ![q isEqualToString:@"default"] && ![q isEqualToString:@"compact"]) {
        [bits addObject:q];
      }
      NSString *display = [bits componentsJoinedByString:@" · "];
      NSString *row = [NSString stringWithFormat:
        @"{\"id\":\"%@\",\"name\":\"%@\",\"lang\":\"%@\",\"gender\":\"%@\",\"quality\":\"%@\"}",
        jsonEscape(v.identifier),
        jsonEscape(display),
        jsonEscape(v.language),
        jsonEscape(g),
        jsonEscape(q)];
      [items addObject:row];
    }
  };

  if ([NSThread isMainThread]) collect();
  else dispatch_sync(dispatch_get_main_queue(), collect);

  NSString *json = [NSString stringWithFormat:@"[%@]", [items componentsJoinedByString:@","]];
  const char *c = json.UTF8String ?: "[]";
  if ((int)strlen(c) >= out_buf_len) {
    setErr(out_buf, out_buf_len, @"voice list quá dài");
    return 2;
  }
  strncpy(out_buf, c, (size_t)out_buf_len - 1);
  out_buf[out_buf_len - 1] = 0;
  return 0;
}

void apple_speak_stop(void) {
  if (!gSpeaker) return;
  [gSpeaker stop];
}
