#import "AppleListen.h"
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <Speech/Speech.h>
#import <Accelerate/Accelerate.h>
#import <stdatomic.h>

@interface CTSystemTap : NSObject
@property (nonatomic, copy) void (^onAudio)(AVAudioPCMBuffer *);
/// Chỉ tap process thuộc bundle (và helper cùng prefix). Không global.
- (BOOL)startWithBundleId:(NSString *)bundleId muteOriginal:(BOOL)muteOriginal error:(NSError **)error;
- (BOOL)setMuteOriginal:(BOOL)muteOriginal error:(NSError **)error;
- (void)stop;
@end

@interface CTEnglishSTT : NSObject <SFSpeechRecognitionTaskDelegate>
- (instancetype)initWithCallback:(AppleListenTranscriptCb)cb
                        statusCb:(AppleListenStatusCb)statusCb
                        userData:(void *)userData;
- (void)append:(AVAudioPCMBuffer *)buffer;
- (void)stop;
@end

static AppleListenTranscriptCb gCb = NULL;
static AppleListenStatusCb gStatusCb = NULL;
static void *gUser = NULL;
static CTSystemTap *gTap = nil;
static CTEnglishSTT *gStt = nil;
static BOOL gRunning = NO;
static char gEngine[32] = "none";
static _Atomic float gPeakRms = 0.f;
static _Atomic int gGated = 0;
static _Atomic int gMuteOriginal = 0;
static char gBundleId[256] = "";

static void setErr(char *buf, int32_t len, NSString *msg) {
  if (!buf || len <= 0) return;
  const char *c = msg.UTF8String ?: "error";
  strncpy(buf, c, (size_t)len - 1);
  buf[len - 1] = 0;
}

static void notePeak(float rms) {
  float cur = atomic_load(&gPeakRms);
  while (rms > cur && !atomic_compare_exchange_weak(&gPeakRms, &cur, rms)) {}
}

static void emitStatus(NSString *msg) {
  if (!gStatusCb || msg.length == 0) return;
  gStatusCb(msg.UTF8String, gUser);
}

void apple_listen_engine(char *out_buf, int32_t out_buf_len) {
  if (!out_buf || out_buf_len <= 0) return;
  strncpy(out_buf, gEngine, (size_t)out_buf_len - 1);
  out_buf[out_buf_len - 1] = 0;
}

float apple_listen_take_peak_rms(void) {
  return atomic_exchange(&gPeakRms, 0.f);
}

int32_t apple_listen_running(void) {
  return gRunning ? 1 : 0;
}

void apple_listen_set_gated(int32_t gated) {
  atomic_store(&gGated, gated ? 1 : 0);
  if (!gated) {
    // Cho phép task mới khi có tiếng — không cần làm gì thêm
    return;
  }
  // Chỉ hủy task đang chạy; giữ gStt để ungated là nghe tiếp được
  CTEnglishSTT *stt = gStt;
  if (stt) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [stt stop];
    });
  }
  atomic_store(&gPeakRms, 0.f);
}

int32_t apple_listen_mute_original(void) {
  return atomic_load(&gMuteOriginal) ? 1 : 0;
}

void apple_listen_set_mute_original(int32_t muted) {
  atomic_store(&gMuteOriginal, muted ? 1 : 0);
  CTSystemTap *tap = gTap;
  if (!tap || !gRunning) return;
  void (^apply)(void) = ^{
    NSError *err = nil;
    BOOL ok = [tap setMuteOriginal:muted != 0 error:&err];
    if (!ok) {
      // Một số OS không đổi live — recreate tap với muteBehavior mới
      NSString *bid = [NSString stringWithUTF8String:gBundleId];
      if (bid.length > 0) {
        err = nil;
        ok = [tap startWithBundleId:bid muteOriginal:muted != 0 error:&err];
      }
    }
    if (!ok) {
      NSLog(@"[AppleListen] setMuteOriginal failed: %@", err.localizedDescription);
      emitStatus(err.localizedDescription ?: @"Không đổi mute âm gốc");
    } else {
      emitStatus(muted ? @"Đã tắt âm gốc — vẫn dịch/TTS" : @"Đã bật lại âm gốc");
    }
  };
  if ([NSThread isMainThread]) apply();
  else dispatch_async(dispatch_get_main_queue(), apply);
}

static void apple_listen_stop_locked(void) {
  gRunning = NO;
  [gTap stop];
  [gStt stop];
  gTap = nil;
  gStt = nil;
  gCb = NULL;
  gStatusCb = NULL;
  gUser = NULL;
  atomic_store(&gPeakRms, 0.f);
  gBundleId[0] = 0;
  strncpy(gEngine, "none", sizeof(gEngine) - 1);
}

void apple_listen_stop(void) {
  if ([NSThread isMainThread]) {
    apple_listen_stop_locked();
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{ apple_listen_stop_locked(); });
  }
}

static int32_t apple_listen_start_locked(NSString *bundleId,
                                         AppleListenTranscriptCb cb,
                                         AppleListenStatusCb status_cb,
                                         void *user_data,
                                         char *err_buf,
                                         int32_t err_buf_len) {
  apple_listen_stop_locked();
  if (!cb) {
    setErr(err_buf, err_buf_len, @"missing callback");
    return 1;
  }
  if (bundleId.length == 0) {
    setErr(err_buf, err_buf_len, @"Chưa chọn app để nghe");
    return 1;
  }

  SFSpeechRecognizerAuthorizationStatus auth = [SFSpeechRecognizer authorizationStatus];
  if (auth == SFSpeechRecognizerAuthorizationStatusNotDetermined) {
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block BOOL ok = NO;
    [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus s) {
      ok = (s == SFSpeechRecognizerAuthorizationStatusAuthorized);
      dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)30 * NSEC_PER_SEC));
    if (!ok) {
      setErr(err_buf, err_buf_len, @"Chưa cấp quyền Speech Recognition");
      return 2;
    }
  } else if (auth != SFSpeechRecognizerAuthorizationStatusAuthorized) {
    setErr(err_buf, err_buf_len, @"Speech Recognition bị từ chối — System Settings › Privacy › Speech Recognition");
    return 2;
  }

  gCb = cb;
  gStatusCb = status_cb;
  gUser = user_data;
  gStt = [[CTEnglishSTT alloc] initWithCallback:cb statusCb:status_cb userData:user_data];
  if (!gStt) {
    setErr(err_buf, err_buf_len, @"SFSpeechRecognizer en-US không sẵn sàng (bật Dictation + tải English)");
    return 3;
  }

  gTap = [CTSystemTap new];
  __weak CTEnglishSTT *weakStt = gStt;
  gTap.onAudio = ^(AVAudioPCMBuffer *buf) {
    [weakStt append:buf];
  };

  NSError *err = nil;
  BOOL mute = atomic_load(&gMuteOriginal) != 0;
  if (![gTap startWithBundleId:bundleId muteOriginal:mute error:&err]) {
    apple_listen_stop_locked();
    setErr(err_buf, err_buf_len, err.localizedDescription ?: @"Process Tap failed — cần System Audio Recording");
    return 4;
  }

  strncpy(gBundleId, bundleId.UTF8String ?: "", sizeof(gBundleId) - 1);
  gBundleId[sizeof(gBundleId) - 1] = 0;
  strncpy(gEngine, "sfspeech", sizeof(gEngine) - 1);
  gRunning = YES;
  emitStatus([NSString stringWithFormat:@"Listen · %@%@", bundleId, mute ? @" · tắt âm gốc" : @""]);
  return 0;
}

int32_t apple_listen_start(const char *bundle_id_utf8,
                           AppleListenTranscriptCb cb,
                           AppleListenStatusCb status_cb,
                           void *user_data,
                           char *err_buf,
                           int32_t err_buf_len) {
  NSString *bundleId = bundle_id_utf8
    ? [NSString stringWithUTF8String:bundle_id_utf8]
    : @"";
  __block int32_t code = 1;
  if ([NSThread isMainThread]) {
    code = apple_listen_start_locked(bundleId, cb, status_cb, user_data, err_buf, err_buf_len);
  } else {
    dispatch_sync(dispatch_get_main_queue(), ^{
      code = apple_listen_start_locked(bundleId, cb, status_cb, user_data, err_buf, err_buf_len);
    });
  }
  return code;
}

#pragma mark - STT

@implementation CTEnglishSTT {
  SFSpeechRecognizer *_recognizer;
  SFSpeechAudioBufferRecognitionRequest *_request;
  SFSpeechRecognitionTask *_task;
  AVAudioFormat *_targetFormat;
  AVAudioConverter *_converter;
  AppleListenTranscriptCb _cb;
  AppleListenStatusCb _statusCb;
  void *_user;
  dispatch_queue_t _q;
  BOOL _onDevice;
  BOOL _taskActive;
  BOOL _speechSeen;
  int _silence;
  int _idleBuffers;
  int _voicedBuffers;
  NSString *_lastPartial;
}

- (instancetype)initWithCallback:(AppleListenTranscriptCb)cb
                        statusCb:(AppleListenStatusCb)statusCb
                        userData:(void *)userData {
  self = [super init];
  if (!self) return nil;
  _recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:@"en-US"]];
  if (!_recognizer || !_recognizer.isAvailable) return nil;
  _onDevice = _recognizer.supportsOnDeviceRecognition;
  _cb = cb;
  _statusCb = statusCb;
  _user = userData;
  _targetFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:16000 channels:1 interleaved:NO];
  _q = dispatch_queue_create("ct.apple.listen.stt", DISPATCH_QUEUE_SERIAL);
  _lastPartial = @"";
  _taskActive = NO;
  return self;
}

- (void)startTask {
  if (_taskActive) return;
  _request = [SFSpeechAudioBufferRecognitionRequest new];
  _request.shouldReportPartialResults = YES;
  _request.requiresOnDeviceRecognition = _onDevice;
  if (@available(macOS 13.0, *)) {
    _request.addsPunctuation = YES;
  }
  _request.taskHint = SFSpeechRecognitionTaskHintDictation;
  _task = [_recognizer recognitionTaskWithRequest:_request delegate:self];
  _taskActive = YES;
  _silence = 0;
  _speechSeen = NO;
  _lastPartial = @"";
}

- (void)endTaskRestart:(BOOL)restart {
  SFSpeechAudioBufferRecognitionRequest *req = _request;
  SFSpeechRecognitionTask *task = _task;
  _request = nil;

  if (restart) {
    // Hủy ngay — không chờ final
    [task cancel];
    _task = nil;
    _taskActive = NO;
    _speechSeen = NO;
    _silence = 0;
    _lastPartial = @"";
    return;
  }

  // Cắt câu: endAudio + finish, GIỮ _task để didFinishRecognition còn khớp và emit final.
  // (Trước đây nil _task sớm → final bị nuốt → không dịch / không TTS.)
  if (req) {
    [req endAudio];
  }
  if (task) {
    [task finish];
  } else {
    _taskActive = NO;
    _speechSeen = NO;
    _silence = 0;
  }
}

- (void)append:(AVAudioPCMBuffer *)buffer {
  dispatch_async(_q, ^{
    // TTS đang phát → không đưa audio vào STT (tránh tự nghe / tự dịch vòng)
    if (atomic_load(&gGated)) {
      if (self->_taskActive) {
        [self endTaskRestart:YES];
      }
      return;
    }

    AVAudioPCMBuffer *converted = [self convert:buffer];
    if (!converted) return;

    float rms = 0;
    if (converted.floatChannelData && converted.floatChannelData[0]) {
      vDSP_rmsqv(converted.floatChannelData[0], 1, &rms, converted.frameLength);
    }
    notePeak(rms);

    const float speechThresh = 0.012f;
    const BOOL voiced = rms > speechThresh;

    if (voiced) {
      self->_idleBuffers = 0;
      self->_voicedBuffers += 1;
    } else {
      self->_idleBuffers += 1;
      self->_voicedBuffers = 0;
    }

    // ~2.5s im lặng hoàn toàn → nhắc UI (buffer ~20ms @16k → 128 ≈ 2.5s)
    if (!self->_taskActive && self->_idleBuffers == 128) {
      if (self->_statusCb) {
        self->_statusCb("Chưa nghe được tiếng hệ thống — phát YouTube/Zoom tiếng Anh thử", self->_user);
      }
    }

    // Chỉ mở recognition khi có vài buffer có tiếng (tránh task chết vì silence đầu)
    if (!self->_taskActive) {
      if (self->_voicedBuffers >= 3) {
        [self startTask];
      } else {
        return;
      }
    }

    if (!self->_request) return;

    if (voiced) {
      self->_speechSeen = YES;
      self->_silence = 0;
    } else if (self->_speechSeen) {
      self->_silence += 1;
    }

    [self->_request appendAudioPCMBuffer:converted];

    // ~0.65–0.8s im lặng → cắt utterance (đổi người nói / hết ý nhanh hơn, đỡ dồn một cục)
    // Buffer convert ~10–20ms; ~55 ≈ 0.7s tùy device.
    if (self->_speechSeen && self->_silence >= 55) {
      [self endTaskRestart:NO];
      // startTask mới sẽ mở khi có tiếng tiếp
    }
  });
}

- (AVAudioPCMBuffer *)convert:(AVAudioPCMBuffer *)buffer {
  if (fabs(buffer.format.sampleRate - _targetFormat.sampleRate) < 1.0 && buffer.format.channelCount == 1
      && buffer.format.commonFormat == AVAudioPCMFormatFloat32 && !buffer.format.isInterleaved) {
    return buffer;
  }
  if (!_converter || ![_converter.inputFormat isEqual:buffer.format]) {
    _converter = [[AVAudioConverter alloc] initFromFormat:buffer.format toFormat:_targetFormat];
  }
  if (!_converter) return nil;
  double ratio = _targetFormat.sampleRate / buffer.format.sampleRate;
  AVAudioFrameCount cap = (AVAudioFrameCount)(buffer.frameLength * ratio) + 32;
  AVAudioPCMBuffer *out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_targetFormat frameCapacity:cap];
  if (!out) return nil;
  NSError *error = nil;
  __block BOOL consumed = NO;
  AVAudioConverterOutputStatus status = [_converter convertToBuffer:out error:&error withInputFromBlock:^AVAudioBuffer * _Nullable(AVAudioPacketCount inNumPackets, AVAudioConverterInputStatus *outStatus) {
    (void)inNumPackets;
    if (consumed) {
      *outStatus = AVAudioConverterInputStatus_NoDataNow;
      return nil;
    }
    consumed = YES;
    *outStatus = AVAudioConverterInputStatus_HaveData;
    return buffer;
  }];
  if (error || status == AVAudioConverterOutputStatus_Error) return nil;
  if (out.frameLength == 0) return nil;
  return out;
}

- (void)stop {
  dispatch_sync(_q, ^{
    [self endTaskRestart:YES];
  });
}

- (void)emit:(NSString *)text final:(BOOL)isFinal {
  if (atomic_load(&gGated)) return;
  NSString *t = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (t.length == 0 || !_cb) return;
  _cb(t.UTF8String, isFinal ? 1 : 0, _user);
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task didHypothesizeTranscription:(SFTranscription *)transcription {
  if (task != _task) return;
  _lastPartial = transcription.formattedString ?: @"";
  [self emit:_lastPartial final:NO];
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task didFinishRecognition:(SFSpeechRecognitionResult *)recognitionResult {
  // Cho phép final ngay cả khi _task sắp được clear ở didFinishSuccessfully.
  if (_task != nil && task != _task) return;
  NSString *text = recognitionResult.bestTranscription.formattedString ?: @"";
  if (text.length == 0) text = _lastPartial ?: @"";
  [self emit:text final:YES];
  _lastPartial = @"";
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task didFinishSuccessfully:(BOOL)successfully {
  dispatch_async(_q, ^{
    if (self->_task != nil && task != self->_task) return;
    // Fallback nếu hệ thống không gọi didFinishRecognition
    if (self->_lastPartial.length > 0) {
      [self emit:self->_lastPartial final:YES];
      self->_lastPartial = @"";
    }
    self->_task = nil;
    self->_request = nil;
    self->_taskActive = NO;
    self->_speechSeen = NO;
    self->_silence = 0;
    if (!successfully) {
      // On-device đôi khi fail → thử lại không bắt buộc on-device
      if (self->_onDevice) {
        self->_onDevice = NO;
        if (self->_statusCb) {
          self->_statusCb("STT on-device lỗi — chuyển sang nhận diện thường", self->_user);
        }
      }
    }
  });
}

- (void)speechRecognitionTaskWasCancelled:(SFSpeechRecognitionTask *)task {
  dispatch_async(_q, ^{
    if (self->_task != nil && task != self->_task) return;
    self->_task = nil;
    self->_request = nil;
    self->_taskActive = NO;
    self->_speechSeen = NO;
    self->_silence = 0;
  });
}

@end

#pragma mark - Process Tap

@implementation CTSystemTap {
  AudioUnit _unit;
  AudioObjectID _tapID;
  AudioObjectID _aggregateID;
  AVAudioFormat *_clientFormat;
  AVAudioFormat *_monoFormat;
  AVAudioPCMBuffer *_renderBuffer;
}

- (instancetype)init {
  self = [super init];
  _tapID = kAudioObjectUnknown;
  _aggregateID = kAudioObjectUnknown;
  _unit = NULL;
  return self;
}

+ (AudioObjectID)defaultOutputDevice {
  AudioObjectID device = kAudioObjectUnknown;
  UInt32 size = sizeof(device);
  AudioObjectPropertyAddress addr = {
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &device) != noErr) return kAudioObjectUnknown;
  return device;
}

+ (Float64)sampleRate:(AudioObjectID)device {
  Float64 rate = 0;
  UInt32 size = sizeof(rate);
  AudioObjectPropertyAddress addr = {
    kAudioDevicePropertyNominalSampleRate,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, &rate) != noErr) return 0;
  return rate;
}

/// Gốc “họ” app — Safari/WebKit chung một họ; Chrome helper chung Chrome.
+ (NSString *)audioFamilyRoot:(NSString *)bundleId {
  if (bundleId.length == 0) return @"";
  NSString *l = bundleId.lowercaseString;
  if ([l hasPrefix:@"com.apple.safari"] ||
      [l containsString:@"safaripatformsupport"] ||
      [l hasPrefix:@"com.apple.webkit"]) {
    return @"family.safari";
  }
  if ([l hasPrefix:@"com.google.chrome"]) return @"family.chrome";
  if ([l hasPrefix:@"com.brave.browser"]) return @"family.brave";
  if ([l hasPrefix:@"company.thebrowser.browser"]) return @"family.arc";
  if ([l hasPrefix:@"org.mozilla.firefox"]) return @"family.firefox";
  if ([l hasPrefix:@"com.microsoft.edgemac"]) return @"family.edge";
  if ([l hasPrefix:@"us.zoom.xos"] || [l hasPrefix:@"zoom.us"]) return @"family.zoom";
  if ([l hasPrefix:@"com.hnc.discord"] || [l hasPrefix:@"com.discord"] ||
      [l containsString:@".discord"]) {
    return @"family.discord";
  }
  if ([l hasPrefix:@"com.tinyspeck.slackmacgap"] || [l containsString:@"slack"]) {
    return @"family.slack";
  }

  // Strip .helper / .gpu / …
  NSString *root = bundleId;
  NSArray<NSString *> *cut = @[
    @".helper", @".Helper", @".gpu", @".GPU", @".plugin", @".Plugin",
    @".renderer", @".webcontent", @".WebContent", @".networking", @".Networking",
  ];
  for (NSString *s in cut) {
    NSRange r = [root rangeOfString:s];
    if (r.location != NSNotFound) {
      root = [root substringToIndex:r.location];
      break;
    }
  }
  return root;
}

+ (BOOL)bundle:(NSString *)bid matchesTargetFamily:(NSString *)target {
  if (!bid.length || !target.length) return NO;
  if ([bid isEqualToString:target]) return YES;
  if ([bid hasPrefix:[target stringByAppendingString:@"."]]) return YES;
  if ([target hasPrefix:[bid stringByAppendingString:@"."]]) return YES;
  NSString *tf = [self audioFamilyRoot:target];
  NSString *bf = [self audioFamilyRoot:bid];
  return tf.length > 0 && [tf isEqualToString:bf];
}

+ (NSString *)bundleIdForProcessObject:(AudioObjectID)obj {
  AudioObjectPropertyAddress addr = {
    kAudioProcessPropertyBundleID,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  CFStringRef cf = NULL;
  UInt32 size = sizeof(cf);
  if (AudioObjectGetPropertyData(obj, &addr, 0, NULL, &size, &cf) != noErr || !cf) {
    return nil;
  }
  return (__bridge_transfer NSString *)cf;
}

/// Process đang có mặt trong Core Audio (đang/đã IO) thuộc họ bundle đã chọn.
+ (NSArray<NSNumber *> *)processObjectsForBundleId:(NSString *)bundleId {
  if (bundleId.length == 0) return @[];

  AudioObjectPropertyAddress listAddr = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &listAddr, 0, NULL, &size) != noErr || size == 0) {
    return @[];
  }
  AudioObjectID *ids = (AudioObjectID *)malloc(size);
  if (!ids) return @[];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &listAddr, 0, NULL, &size, ids) != noErr) {
    free(ids);
    return @[];
  }
  NSUInteger count = size / sizeof(AudioObjectID);
  NSMutableArray<NSNumber *> *objs = [NSMutableArray new];
  NSMutableSet<NSNumber *> *seen = [NSMutableSet new];
  for (NSUInteger i = 0; i < count; i++) {
    AudioObjectID obj = ids[i];
    NSString *bid = [self bundleIdForProcessObject:obj];
    if (![self bundle:bid matchesTargetFamily:bundleId]) continue;
    NSNumber *n = @(obj);
    if ([seen containsObject:n]) continue;
    [seen addObject:n];
    [objs addObject:n];
  }
  free(ids);
  return objs;
}

+ (UInt32)inputChannels:(AudioObjectID)device {
  AudioObjectPropertyAddress addr = {
    kAudioDevicePropertyStreamConfiguration,
    kAudioObjectPropertyScopeInput,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size) != noErr || size == 0) return 0;
  AudioBufferList *list = (AudioBufferList *)malloc(size);
  if (!list) return 0;
  UInt32 channels = 0;
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, list) == noErr) {
    for (UInt32 i = 0; i < list->mNumberBuffers; i++) channels += list->mBuffers[i].mNumberChannels;
  }
  free(list);
  return channels;
}

+ (NSString *)defaultOutputUID {
  AudioObjectID device = [self defaultOutputDevice];
  if (device == kAudioObjectUnknown) return nil;
  AudioObjectPropertyAddress addr = {
    kAudioDevicePropertyDeviceUID,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  CFStringRef uid = NULL;
  UInt32 size = sizeof(uid);
  if (AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, &uid) != noErr || !uid) return nil;
  return (__bridge_transfer NSString *)uid;
}

static OSStatus CTRenderCallback(void *inRefCon, AudioUnitRenderActionFlags *ioActionFlags,
                                  const AudioTimeStamp *inTimeStamp, UInt32 inBusNumber,
                                  UInt32 inNumberFrames, AudioBufferList *ioData) {
  (void)ioActionFlags;
  (void)ioData;
  CTSystemTap *tap = (__bridge CTSystemTap *)inRefCon;
  return [tap render:inTimeStamp bus:inBusNumber frames:inNumberFrames];
}

- (OSStatus)render:(const AudioTimeStamp *)ts bus:(UInt32)bus frames:(UInt32)frames {
  if (!_unit || !_clientFormat) return noErr;
  if (!_renderBuffer || _renderBuffer.frameCapacity < frames) {
    _renderBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_clientFormat frameCapacity:frames];
  }
  if (!_renderBuffer) return noErr;
  _renderBuffer.frameLength = frames;
  AudioUnitRenderActionFlags flags = 0;
  OSStatus status = AudioUnitRender(_unit, &flags, ts, bus, frames, _renderBuffer.mutableAudioBufferList);
  if (status != noErr) return status;

  if (!_monoFormat) return noErr;
  AVAudioPCMBuffer *mono = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_monoFormat frameCapacity:frames];
  if (!mono || !_renderBuffer.floatChannelData || !mono.floatChannelData) return noErr;
  mono.frameLength = frames;
  float *dst = mono.floatChannelData[0];
  float *L = _renderBuffer.floatChannelData[0];
  if (_clientFormat.channelCount >= 2) {
    float *R = _renderBuffer.floatChannelData[1];
    for (UInt32 i = 0; i < frames; i++) dst[i] = (L[i] + R[i]) * 0.5f;
  } else {
    memcpy(dst, L, frames * sizeof(float));
  }
  if (self.onAudio) self.onAudio(mono);
  return noErr;
}

- (BOOL)setMuteOriginal:(BOOL)muteOriginal error:(NSError **)error {
  if (_tapID == kAudioObjectUnknown) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:-20 userInfo:@{NSLocalizedDescriptionKey: @"Chưa có Process Tap"}];
    return NO;
  }
  AudioObjectPropertyAddress addr = {
    kAudioTapPropertyDescription,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  CATapDescription *desc = nil;
  UInt32 size = sizeof(desc);
  OSStatus status = AudioObjectGetPropertyData(_tapID, &addr, 0, NULL, &size, &desc);
  if (status != noErr || !desc) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"Không đọc tap description"}];
    return NO;
  }
  desc.muteBehavior = muteOriginal ? CATapMuted : CATapUnmuted;
  status = AudioObjectSetPropertyData(_tapID, &addr, 0, NULL, sizeof(desc), &desc);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Set mute %d", (int)status]}];
    return NO;
  }
  return YES;
}

- (BOOL)startWithBundleId:(NSString *)bundleId muteOriginal:(BOOL)muteOriginal error:(NSError **)error {
  [self stop];

  // Safari/Chrome: audio thường nằm ở helper/WebKit — lấy mọi process object cùng họ đang có trong HAL.
  NSArray<NSNumber *> *processObjs = [CTSystemTap processObjectsForBundleId:bundleId];
  if (processObjs.count == 0) {
    NSString *hint = [CTSystemTap audioFamilyRoot:bundleId];
    BOOL safari = [hint isEqualToString:@"family.safari"];
    NSString *msg = safari
      ? @"Safari/WebKit chưa phát audio trong Core Audio. Mở tab có tiếng (YouTube…), chọn «Safari» (không phải Helper), rồi bật Listen lại"
      : [NSString stringWithFormat:@"`%@` chưa có process audio trong Core Audio. Phát tiếng trong app rồi bật Listen lại", bundleId];
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:-11 userInfo:@{NSLocalizedDescriptionKey: msg}];
    return NO;
  }

  CATapDescription *desc = [[CATapDescription alloc] initStereoMixdownOfProcesses:processObjs];
  desc.name = [NSString stringWithFormat:@"CicadaTauri·%@", bundleId];
  desc.privateTap = YES;
  // CATapMuted: app gốc im trên loa, Cicada vẫn nhận buffer → STT/dịch/TTS
  desc.muteBehavior = muteOriginal ? CATapMuted : CATapUnmuted;

  AudioObjectID tap = kAudioObjectUnknown;
  OSStatus status = AudioHardwareCreateProcessTap(desc, &tap);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"CreateProcessTap %d — cần System Audio Recording", (int)status]}];
    return NO;
  }
  _tapID = tap;

  NSString *outputUID = [CTSystemTap defaultOutputUID];
  if (!outputUID) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:-1 userInfo:@{NSLocalizedDescriptionKey: @"Không thấy default output"}];
    [self stop];
    return NO;
  }

  NSString *aggUID = [NSString stringWithFormat:@"com.cicada.tauri.%@", NSUUID.UUID.UUIDString];
  NSDictionary *aggregate = @{
    @(kAudioAggregateDeviceNameKey): @"CicadaTauri Tap",
    @(kAudioAggregateDeviceUIDKey): aggUID,
    @(kAudioAggregateDeviceMainSubDeviceKey): outputUID,
    @(kAudioAggregateDeviceIsPrivateKey): @YES,
    @(kAudioAggregateDeviceIsStackedKey): @NO,
    @(kAudioAggregateDeviceTapAutoStartKey): @YES,
    @(kAudioAggregateDeviceSubDeviceListKey): @[@{@(kAudioSubDeviceUIDKey): outputUID}],
    @(kAudioAggregateDeviceTapListKey): @[
      @{
        @(kAudioSubTapUIDKey): desc.UUID.UUIDString,
        @(kAudioSubTapDriftCompensationKey): @YES,
      }
    ],
  };

  AudioObjectID agg = kAudioObjectUnknown;
  status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregate, &agg);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"CreateAggregate %d", (int)status]}];
    [self stop];
    return NO;
  }
  _aggregateID = agg;

  AudioComponentDescription comp = {
    kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0
  };
  AudioComponent found = AudioComponentFindNext(NULL, &comp);
  if (!found) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:-2 userInfo:@{NSLocalizedDescriptionKey: @"HAL component"}];
    [self stop];
    return NO;
  }
  status = AudioComponentInstanceNew(found, &_unit);
  if (status != noErr || !_unit) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"AudioUnit new"}];
    [self stop];
    return NO;
  }

  UInt32 disableOutput = 0, enableInput = 1;
  AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &disableOutput, sizeof(disableOutput));
  AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enableInput, sizeof(enableInput));
  status = AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &_aggregateID, sizeof(_aggregateID));
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"Set device"}];
    [self stop];
    return NO;
  }

  AudioStreamBasicDescription hardware = {0};
  UInt32 hardwareSize = sizeof(hardware);
  OSStatus read = AudioUnitGetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &hardwareSize);
  Float64 sampleRate = (read == noErr && hardware.mSampleRate > 0) ? hardware.mSampleRate : 48000;
  Float64 samplesRate = [CTSystemTap sampleRate:_aggregateID];
  if (samplesRate <= 0) samplesRate = sampleRate;

  AudioStreamBasicDescription asbd = {
    .mSampleRate = sampleRate,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
    .mBytesPerPacket = 4, .mFramesPerPacket = 1, .mBytesPerFrame = 4,
    .mChannelsPerFrame = 2, .mBitsPerChannel = 32, .mReserved = 0
  };
  _clientFormat = [[AVAudioFormat alloc] initWithStreamDescription:&asbd];
  _monoFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:samplesRate channels:1 interleaved:NO];
  _renderBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_clientFormat frameCapacity:4096];

  status = AudioUnitSetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &asbd, sizeof(asbd));
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"Set format"}];
    [self stop];
    return NO;
  }

  UInt32 mics = [CTSystemTap inputChannels:[CTSystemTap defaultOutputDevice]];
  if (mics > 0) {
    SInt32 map[2] = {(SInt32)mics, (SInt32)(mics + 1)};
    AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_ChannelMap, kAudioUnitScope_Output, 1, map, sizeof(map));
  }

  AURenderCallbackStruct cb = { CTRenderCallback, (__bridge void *)self };
  status = AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, sizeof(cb));
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"Set callback"}];
    [self stop];
    return NO;
  }

  status = AudioUnitInitialize(_unit);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: @"Initialize"}];
    [self stop];
    return NO;
  }
  status = AudioOutputUnitStart(_unit);
  if (status != noErr) {
    if (error) *error = [NSError errorWithDomain:@"AppleListenTap" code:status userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Start %d — cần System Audio Recording", (int)status]}];
    [self stop];
    return NO;
  }
  return YES;
}

- (void)stop {
  if (_unit) {
    AudioOutputUnitStop(_unit);
    AudioUnitUninitialize(_unit);
    AudioComponentInstanceDispose(_unit);
    _unit = NULL;
  }
  if (_aggregateID != kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(_aggregateID);
    _aggregateID = kAudioObjectUnknown;
  }
  if (_tapID != kAudioObjectUnknown) {
    AudioHardwareDestroyProcessTap(_tapID);
    _tapID = kAudioObjectUnknown;
  }
  _clientFormat = nil;
  _monoFormat = nil;
  _renderBuffer = nil;
}

- (void)dealloc { [self stop]; }

@end
