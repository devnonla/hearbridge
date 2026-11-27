import AVFoundation
import CoreAudio
import Foundation
import Speech

#if canImport(Darwin)
import Darwin
#endif

private func isSiriAssetKey(_ id: String?) -> Bool {
  guard let id, !id.isEmpty else { return false }
  // assetKey kiểu: vi-VN-u-sd-vnct:neural:male:vi-VN-D:premium:1044
  return id.contains(":neural:") || id.contains(":natural:") || id.contains(":fmvoice:")
}

private final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  static let shared = Speaker()

  private let synth = AVSpeechSynthesizer()
  private var done: DispatchSemaphore?
  private var token: UInt = 0
  private var ok = true
  private var err: String?

  private override init() {
    super.init()
    synth.delegate = self
  }

  private func signalDoneIfNeeded() {
    guard let sem = done else { return }
    done = nil
    sem.signal()
  }

  func stop() {
    let block = {
      self.token &+= 1
      self.synth.stopSpeaking(at: .immediate)
      self.ok = true
      self.signalDoneIfNeeded()
    }
    if Thread.isMainThread { block() }
    else { DispatchQueue.main.sync(execute: block) }
  }

  func speak(
    text: String,
    lang: String,
    voiceId: String?,
    rate01: Float,
    pitch: Float,
    volume: Float
  ) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "empty text" }

    let sem = DispatchSemaphore(value: 0)
    let start: () -> Void = {
      self.token &+= 1
      let myToken = self.token
      self.ok = true
      self.err = nil
      self.signalDoneIfNeeded()
      self.done = sem

      if self.synth.isSpeaking {
        self.synth.stopSpeaking(at: .immediate)
      }

      let u = AVSpeechUtterance(string: trimmed)
      u.voice = bestVoice(lang: lang, preferredId: voiceId)

      var t = rate01
      if !(t >= 0 && t <= 1) { t = 0.62 }
      let minR = AVSpeechUtteranceMinimumSpeechRate
      let maxR = AVSpeechUtteranceMaximumSpeechRate
      u.rate = minR + (maxR - minR) * t

      var p = pitch
      if !(p >= 0.5 && p <= 2) { p = 1 }
      u.pitchMultiplier = p

      var vol = volume
      if !(vol >= 0 && vol <= 1) { vol = 0.45 }
      u.volume = vol
      u.preUtteranceDelay = 0
      u.postUtteranceDelay = 0.02

      objc_setAssociatedObject(u, &AssociatedKeys.token, myToken, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      NSLog(
        "[AppleSpeak] speak voice=%@ id=%@ rate=%.3f pitch=%.2f vol=%.2f",
        u.voice?.name ?? "?",
        u.voice?.identifier ?? "?",
        u.rate,
        u.pitchMultiplier,
        u.volume
      )
      self.synth.speak(u)
    }

    if Thread.isMainThread { start() }
    else { DispatchQueue.main.async(execute: start) }

    let deadline = Date().addingTimeInterval(180)
    while sem.wait(timeout: .now()) != .success {
      if Date() > deadline {
        stop()
        return "TTS timeout"
      }
      if Thread.isMainThread {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
      } else {
        if sem.wait(timeout: .now() + 0.05) == .success { break }
      }
    }
    return ok ? nil : (err ?? "TTS failed")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    let tok = objc_getAssociatedObject(utterance, &AssociatedKeys.token) as? UInt
    if tok == token {
      ok = true
      signalDoneIfNeeded()
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    let tok = objc_getAssociatedObject(utterance, &AssociatedKeys.token) as? UInt
    if tok == token {
      ok = true
      signalDoneIfNeeded()
    }
  }
}

private enum AssociatedKeys {
  static var token: UInt8 = 0
}

private func normalizeLang(_ raw: String?) -> String {
  guard let raw, !raw.isEmpty else { return "en-US" }
  let lower = raw.lowercased()
  if lower.hasPrefix("vi") { return "vi-VN" }
  if lower.hasPrefix("zh") { return "zh-CN" }
  if lower.hasPrefix("ja") { return "ja-JP" }
  if lower.hasPrefix("ko") { return "ko-KR" }
  if lower.hasPrefix("fr") { return "fr-FR" }
  if lower.hasPrefix("de") { return "de-DE" }
  if lower.hasPrefix("es") { return "es-ES" }
  if lower.hasPrefix("en") { return "en-US" }
  if lower.contains("-") {
    let parts = lower.split(separator: "-")
    if parts.count >= 2 {
      return "\(parts[0])-\(parts[1].uppercased())"
    }
  }
  return "en-US"
}

private func langRoot(_ lang: String) -> String {
  lang.split(separator: "-").first.map(String.init)?.lowercased() ?? lang.lowercased()
}

private func langMatches(voiceLang: String, wantLang: String) -> Bool {
  langRoot(voiceLang) == langRoot(wantLang)
}

private func isNovelty(_ v: AVSpeechSynthesisVoice) -> Bool {
  let id = v.identifier.lowercased()
  let name = v.name.lowercased()
  let bad = [
    "zarvox", "trinoids", "boing", "bubbles", "bells", "cellos", "organ",
    "deranged", "hysterical", "badnews", "goodnews", "whisper", "bahh",
    "princess", "jester", "wobble", "albert", "ralph", "junior", "kathy",
    "fred", "eloquence",
  ]
  return bad.contains { id.contains($0) || name.contains($0) }
}

private func qualityLabel(_ v: AVSpeechSynthesisVoice) -> String {
  if #available(macOS 13.0, *) {
    switch v.quality {
    case .premium: return "premium"
    case .enhanced: return "enhanced"
    default: break
    }
  }
  let id = v.identifier.lowercased()
  if id.contains("premium") || id.contains("gryphon") || id.contains("neural") { return "premium" }
  if id.contains("enhanced") { return "enhanced" }
  if id.contains("compact") { return "compact" }
  return "default"
}

private func genderLabel(_ v: AVSpeechSynthesisVoice) -> String {
  if #available(macOS 10.15, *) {
    switch v.gender {
    case .male: return "male"
    case .female: return "female"
    default: break
    }
  }
  return "unknown"
}

private func voiceScore(_ v: AVSpeechSynthesisVoice, lang: String) -> Int {
  if !langMatches(voiceLang: v.language, wantLang: lang) { return -100_000 }
  if isNovelty(v) { return -50_000 }

  var score = 0
  let ident = v.identifier.lowercased()
  let name = v.name.lowercased()

  if #available(macOS 10.15, *) {
    if v.gender == .male { score += 9000 }
    else if v.gender == .female { score += 500 }
  }

  if #available(macOS 13.0, *) {
    switch v.quality {
    case .premium: score += 20_000
    case .enhanced: score += 15_000
    default: score += 500
    }
  }

  if ident.contains("super-compact") { score -= 22_000 }
  else if ident.contains("compact") { score -= 14_000 }
  if ident.contains("siri.natural") || ident.contains("neural") || ident.contains("gryphon") {
    score += 12_000
  }
  if ident.contains("premium") { score += 6000 }
  else if ident.contains("enhanced") { score += 5000 }

  if lang.hasPrefix("vi") {
    if name == "voice 4" || ident.contains("vi-vn-d_") { score += 9000 }
    if name == "voice 3" || ident.contains("vi-vn-c_") { score += 6000 }
    // Linh chỉ còn fallback khi không có Siri asset
    if name.contains("linh") && ident.contains("enhanced") { score += 2500 }
    else if name.contains("linh") { score += 800 }
  }
  if lang.hasPrefix("en") {
    if ident.contains("aaron") || name.contains("voice 1") { score += 4000 }
  }
  if v.language.lowercased() == lang.lowercased() { score += 100 }
  return score
}

private func bestVoice(lang: String, preferredId: String?) -> AVSpeechSynthesisVoice? {
  if let preferredId, !preferredId.isEmpty,
     let v = AVSpeechSynthesisVoice(identifier: preferredId),
     langMatches(voiceLang: v.language, wantLang: lang)
  {
    return v
  }
  // Swift thấy Siri Voice 3/4; ObjC speechVoices thường thiếu.
  var best: AVSpeechSynthesisVoice?
  var bestScore = Int.min
  for v in AVSpeechSynthesisVoice.speechVoices() {
    let s = voiceScore(v, lang: lang)
    if s > bestScore {
      bestScore = s
      best = v
    }
  }
  return best
    ?? AVSpeechSynthesisVoice(language: lang)
    ?? AVSpeechSynthesisVoice(language: "en-US")
}

private func displayName(_ v: AVSpeechSynthesisVoice) -> String {
  var label = v.name
  if label.range(of: #"^Voice \d+$"#, options: .regularExpression) != nil {
    label = "Siri \(label)"
  }
  let g = genderLabel(v)
  let q = qualityLabel(v)
  var bits = [label]
  if g == "male" { bits.append("nam") }
  else if g == "female" { bits.append("nữ") }
  if q != "default" && q != "compact" { bits.append(q) }
  return bits.joined(separator: " · ")
}

private func jsonEscape(_ s: String) -> String {
  s
    .replacingOccurrences(of: "\\", with: "\\\\")
    .replacingOccurrences(of: "\"", with: "\\\"")
    .replacingOccurrences(of: "\n", with: "\\n")
}

private func setErr(_ buf: UnsafeMutablePointer<CChar>?, _ len: Int32, _ msg: String) {
  guard let buf, len > 0 else { return }
  let bytes = Array(msg.utf8)
  let n = min(Int(len) - 1, bytes.count)
  for i in 0..<n { buf[i] = CChar(bitPattern: bytes[i]) }
  buf[n] = 0
}

@_cdecl("apple_speak")
public func apple_speak(
  _ text_utf8: UnsafePointer<CChar>?,
  _ lang_bcp47: UnsafePointer<CChar>?,
  _ voice_id_utf8: UnsafePointer<CChar>?,
  _ rate_01: Float,
  _ pitch: Float,
  _ volume: Float,
  _ err_buf: UnsafeMutablePointer<CChar>?,
  _ err_buf_len: Int32
) -> Int32 {
  guard let text_utf8 else {
    setErr(err_buf, err_buf_len, "missing text")
    return 1
  }
  let text = String(cString: text_utf8)
  let lang = normalizeLang(lang_bcp47.map { String(cString: $0) })
  let voiceId: String? = {
    guard let voice_id_utf8 else { return nil }
    let s = String(cString: voice_id_utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? nil : s
  }()

  // Siri neural (private SiriTTSService) — cùng đường siri-tts-cli
  if isSiriAssetKey(voiceId) {
    let key = voiceId!
    let code = key.withCString { keyPtr in
      text.withCString { textPtr in
        apple_siri_speak(textPtr, keyPtr, rate_01, pitch, volume, err_buf, err_buf_len)
      }
    }
    return code
  }

  if let err = Speaker.shared.speak(
    text: text, lang: lang, voiceId: voiceId, rate01: rate_01, pitch: pitch, volume: volume
  ) {
    setErr(err_buf, err_buf_len, err)
    return 2
  }
  return 0
}

@_cdecl("apple_speak_list_voices")
public func apple_speak_list_voices(
  _ lang_bcp47: UnsafePointer<CChar>?,
  _ out_buf: UnsafeMutablePointer<CChar>?,
  _ out_buf_len: Int32
) -> Int32 {
  guard let out_buf, out_buf_len >= 4 else { return 1 }
  let lang = normalizeLang(lang_bcp47.map { String(cString: $0) })

  let build: () -> String = {
    var rows: [String] = []

    // 1) Siri đã tải (private daemon) — ưu tiên đầu list
    if apple_siri_available() != 0 {
      var siriBuf = [CChar](repeating: 0, count: 128 * 1024)
      let code = lang.withCString { langPtr in
        apple_siri_list_voices(langPtr, &siriBuf, Int32(siriBuf.count))
      }
      if code == 0 {
        let raw = String(cString: siriBuf)
        if raw.hasPrefix("["), raw.hasSuffix("]"), raw.count > 2 {
          let inner = String(raw.dropFirst().dropLast())
          if !inner.isEmpty { rows.append(inner) }
        }
      }
    }

    // 2) AVSpeech (Linh Enhanced, …)
    var matched: [AVSpeechSynthesisVoice] = []
    for v in AVSpeechSynthesisVoice.speechVoices() {
      if isNovelty(v) { continue }
      if !langMatches(voiceLang: v.language, wantLang: lang) { continue }
      if v.identifier.lowercased().contains("super-compact") { continue }
      matched.append(v)
    }
    matched.sort {
      let sa = voiceScore($0, lang: lang)
      let sb = voiceScore($1, lang: lang)
      if sa != sb { return sa > sb }
      return $0.name < $1.name
    }
    rows.append(contentsOf: matched.map { v in
      let g = genderLabel(v)
      let q = qualityLabel(v)
      return
        "{\"id\":\"\(jsonEscape(v.identifier))\",\"name\":\"\(jsonEscape(displayName(v)))\",\"lang\":\"\(jsonEscape(v.language))\",\"gender\":\"\(jsonEscape(g))\",\"quality\":\"\(jsonEscape(q))\"}"
    })
    return "[\(rows.joined(separator: ","))]"
  }

  let json: String
  if Thread.isMainThread { json = build() }
  else {
    var out = "[]"
    DispatchQueue.main.sync { out = build() }
    json = out
  }

  let bytes = Array(json.utf8)
  if bytes.count >= Int(out_buf_len) {
    setErr(out_buf, out_buf_len, "voice list quá dài")
    return 2
  }
  for i in 0..<bytes.count { out_buf[i] = CChar(bitPattern: bytes[i]) }
  out_buf[bytes.count] = 0
  return 0
}

@_cdecl("apple_speak_stop")
public func apple_speak_stop() {
  apple_siri_stop()
  Speaker.shared.stop()
}

// MARK: - Render to WAV (route Apple voices to a chosen output device)

/// Renders an utterance to 16-bit mono/stereo PCM WAV with `AVSpeechSynthesizer.write`,
/// so the webview can play it on any output device (e.g. a virtual mic for Zoom/Meet).
/// Volume is left to the player. Siri neural voices (private service) can't render.
private final class Renderer {
  static let shared = Renderer()
  private let synth = AVSpeechSynthesizer()
  private let lock = NSLock()

  func render(text: String, lang: String, voiceId: String?, rate01: Float, pitch: Float) -> (Data?, String?) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return (nil, "empty text") }
    if Thread.isMainThread { return (nil, "render must not run on the main thread") }

    lock.lock()
    defer { lock.unlock() }

    let u = AVSpeechUtterance(string: trimmed)
    u.voice = bestVoice(lang: lang, preferredId: voiceId)
    var t = rate01
    if !(t >= 0 && t <= 1) { t = 0.62 }
    u.rate = AVSpeechUtteranceMinimumSpeechRate
      + (AVSpeechUtteranceMaximumSpeechRate - AVSpeechUtteranceMinimumSpeechRate) * t
    var p = pitch
    if !(p >= 0.5 && p <= 2) { p = 1 }
    u.pitchMultiplier = p
    u.volume = 1
    u.preUtteranceDelay = 0
    u.postUtteranceDelay = 0

    let state = RenderState()
    DispatchQueue.main.async {
      self.synth.write(u) { buffer in
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        state.append(pcm)
      }
    }

    // Done on the zero-length buffer; or when buffers stop arriving (some voices never send it).
    let deadline = Date().addingTimeInterval(60)
    while true {
      if state.finished { break }
      if Date() > deadline {
        DispatchQueue.main.async { self.synth.stopSpeaking(at: .immediate) }
        return (nil, "TTS render timeout")
      }
      if let last = state.lastBufferAt, Date().timeIntervalSince(last) > 1.5 { break }
      if state.lastBufferAt == nil, Date().timeIntervalSince(state.startedAt) > 8 {
        return (nil, "giọng này không render được")
      }
      Thread.sleep(forTimeInterval: 0.02)
    }
    return state.wav()
  }
}

private final class RenderState {
  private let q = DispatchQueue(label: "hearbridge.tts.render")
  private var samples: [Int16] = []
  private var sampleRate: Double = 22050
  private var channels: Int = 1
  private var _finished = false
  private var _lastBufferAt: Date?
  let startedAt = Date()

  var finished: Bool { q.sync { _finished } }
  var lastBufferAt: Date? { q.sync { _lastBufferAt } }

  func append(_ buf: AVAudioPCMBuffer) {
    let n = Int(buf.frameLength)
    let ch = max(1, Int(buf.format.channelCount))
    q.sync {
      _lastBufferAt = Date()
      if n == 0 {
        _finished = true
        return
      }
      sampleRate = buf.format.sampleRate
      channels = ch
      let interleaved = buf.format.isInterleaved
      if let f = buf.floatChannelData {
        for i in 0..<n {
          for c in 0..<ch {
            let v = interleaved ? f[0][i * ch + c] : f[c][i]
            samples.append(Int16(max(-1, min(1, v)) * 32767))
          }
        }
      } else if let s = buf.int16ChannelData {
        for i in 0..<n {
          for c in 0..<ch { samples.append(interleaved ? s[0][i * ch + c] : s[c][i]) }
        }
      } else if let s = buf.int32ChannelData {
        for i in 0..<n {
          for c in 0..<ch {
            let v = interleaved ? s[0][i * ch + c] : s[c][i]
            samples.append(Int16(truncatingIfNeeded: v >> 16))
          }
        }
      }
    }
  }

  func wav() -> (Data?, String?) {
    q.sync {
      if samples.isEmpty { return (nil, "TTS render produced no audio") }
      let rate = UInt32(sampleRate.rounded())
      let chans = UInt16(channels)
      let dataLen = UInt32(samples.count * 2)
      var d = Data()
      func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
      func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
      d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataLen)
      d.append(contentsOf: Array("WAVE".utf8))
      d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(chans)
      u32(rate); u32(rate * UInt32(chans) * 2); u16(chans * 2); u16(16)
      d.append(contentsOf: Array("data".utf8)); u32(dataLen)
      samples.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
      return (d, nil)
    }
  }
}

/// Render to WAV. On success `*out_ptr` is a malloc'd buffer the caller frees with `apple_speak_free`.
@_cdecl("apple_speak_render")
public func apple_speak_render(
  _ text_utf8: UnsafePointer<CChar>?,
  _ lang_bcp47: UnsafePointer<CChar>?,
  _ voice_id_utf8: UnsafePointer<CChar>?,
  _ rate_01: Float,
  _ pitch: Float,
  _ out_ptr: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>?,
  _ out_len: UnsafeMutablePointer<Int32>?,
  _ err_buf: UnsafeMutablePointer<CChar>?,
  _ err_buf_len: Int32
) -> Int32 {
  guard let text_utf8, let out_ptr, let out_len else {
    setErr(err_buf, err_buf_len, "missing argument")
    return 1
  }
  let voiceId: String? = {
    guard let voice_id_utf8 else { return nil }
    let s = String(cString: voice_id_utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    return s.isEmpty ? nil : s
  }()
  if isSiriAssetKey(voiceId) {
    setErr(err_buf, err_buf_len, "giọng Siri neural không render được")
    return 3
  }
  let (data, err) = Renderer.shared.render(
    text: String(cString: text_utf8),
    lang: normalizeLang(lang_bcp47.map { String(cString: $0) }),
    voiceId: voiceId,
    rate01: rate_01,
    pitch: pitch
  )
  guard let data, err == nil else {
    setErr(err_buf, err_buf_len, err ?? "render failed")
    return 2
  }
  guard let mem = malloc(data.count)?.assumingMemoryBound(to: UInt8.self) else {
    setErr(err_buf, err_buf_len, "out of memory")
    return 4
  }
  data.copyBytes(to: mem, count: data.count)
  out_ptr.pointee = mem
  out_len.pointee = Int32(data.count)
  return 0
}

@_cdecl("apple_speak_free")
public func apple_speak_free(_ ptr: UnsafeMutablePointer<UInt8>?) {
  free(ptr)
}

// MARK: - Speech-to-text from a file (push-to-talk mic recordings)

/// Transcribes an audio file (WAV) with SFSpeechRecognizer: on-device when the language
/// supports it, Apple's server otherwise. Blocks; never call on the main thread.
/// Returns 0 and the text (may be empty when no speech was heard) in `out_buf`.
@_cdecl("apple_transcribe_file")
public func apple_transcribe_file(
  _ path_utf8: UnsafePointer<CChar>?,
  _ lang_bcp47: UnsafePointer<CChar>?,
  _ out_buf: UnsafeMutablePointer<CChar>?,
  _ out_buf_len: Int32,
  _ err_buf: UnsafeMutablePointer<CChar>?,
  _ err_buf_len: Int32
) -> Int32 {
  guard let path_utf8, let out_buf, out_buf_len > 0 else {
    setErr(err_buf, err_buf_len, "missing argument")
    return 1
  }
  if Thread.isMainThread {
    setErr(err_buf, err_buf_len, "transcribe must not run on the main thread")
    return 1
  }

  // Permission (shared with Apple Listen).
  var auth = SFSpeechRecognizer.authorizationStatus()
  if auth == .notDetermined {
    let sem = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { s in
      auth = s
      sem.signal()
    }
    _ = sem.wait(timeout: .now() + 60)
  }
  guard auth == .authorized else {
    setErr(err_buf, err_buf_len, "Chưa cho phép Nhận dạng giọng nói (Cài đặt hệ thống › Quyền riêng tư)")
    return 2
  }

  let lang = normalizeLang(lang_bcp47.map { String(cString: $0) })
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
    setErr(err_buf, err_buf_len, "Apple không hỗ trợ nhận giọng \(lang)")
    return 3
  }
  guard recognizer.isAvailable else {
    setErr(err_buf, err_buf_len, "Nhận giọng Apple \(lang) đang không sẵn sàng")
    return 3
  }
  recognizer.queue = OperationQueue()

  let url = URL(fileURLWithPath: String(cString: path_utf8))
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.shouldReportPartialResults = false
  request.addsPunctuation = true
  if recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
  }

  let sem = DispatchSemaphore(value: 0)
  let lock = NSLock()
  var text = ""
  var failure: String?
  var finished = false
  let task = recognizer.recognitionTask(with: request) { result, error in
    lock.lock()
    defer { lock.unlock() }
    if finished { return }
    if let result {
      text = result.bestTranscription.formattedString
      if result.isFinal {
        finished = true
        sem.signal()
        return
      }
    }
    if let error {
      let ns = error as NSError
      // 1110 = no speech detected: not an error, just nothing to say.
      if !(ns.domain == "kAFAssistantErrorDomain" && ns.code == 1110) {
        failure = ns.localizedDescription
      }
      finished = true
      sem.signal()
    }
  }
  if sem.wait(timeout: .now() + 45) == .timedOut {
    task.cancel()
    setErr(err_buf, err_buf_len, "Nhận giọng Apple quá thời gian")
    return 4
  }
  lock.lock()
  let finalText = text
  let finalFailure = failure
  lock.unlock()
  if let finalFailure, finalText.isEmpty {
    setErr(err_buf, err_buf_len, finalFailure)
    return 5
  }
  let bytes = Array(finalText.utf8.prefix(Int(out_buf_len) - 1))
  bytes.withUnsafeBufferPointer { src in
    out_buf.withMemoryRebound(to: UInt8.self, capacity: Int(out_buf_len)) { dst in
      for (i, b) in src.enumerated() { dst[i] = b }
      dst[src.count] = 0
    }
  }
  return 0
}

// MARK: - Play audio on a specific output device (WKWebView has no working setSinkId)

/// UID of the output device whose name matches (exact, then case-insensitive contains).
private func outputDeviceUID(named name: String) -> String? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr
  else { return nil }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr
  else { return nil }

  func string(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = AudioObjectPropertyAddress(
      mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var cf: Unmanaged<CFString>?
    var sz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &sz, &cf) == noErr, let cf else { return nil }
    return cf.takeRetainedValue() as String
  }
  func hasOutput(_ id: AudioObjectID) -> Bool {
    var a = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeOutput,
      mElement: kAudioObjectPropertyElementMain)
    var sz: UInt32 = 0
    return AudioObjectGetPropertyDataSize(id, &a, 0, nil, &sz) == noErr && sz > 0
  }

  let outputs = ids.filter(hasOutput).compactMap { id -> (String, String)? in
    guard let n = string(id, kAudioObjectPropertyName), let uid = string(id, kAudioDevicePropertyDeviceUID)
    else { return nil }
    return (n, uid)
  }
  if let hit = outputs.first(where: { $0.0 == name }) { return hit.1 }
  let lower = name.lowercased()
  return outputs.first(where: { lower.contains($0.0.lowercased()) || $0.0.lowercased().contains(lower) })?.1
}

private final class DevicePlayback {
  static let shared = DevicePlayback()
  private let lock = NSLock()
  private var players: [AVAudioPlayer] = []

  func stopAll() {
    lock.lock()
    let current = players
    players = []
    lock.unlock()
    current.forEach { $0.stop() }
  }

  /// Blocks until playback ends. `monitor` "" = system default output, nil = no monitor copy.
  func play(data: Data, device: String, monitor: String?, volume: Float) -> String? {
    guard let uid = outputDeviceUID(named: device) else { return "Không tìm thấy thiết bị âm thanh: \(device)" }
    let main: AVAudioPlayer
    do { main = try AVAudioPlayer(data: data) } catch { return "Không đọc được audio: \(error.localizedDescription)" }
    main.currentDevice = uid
    main.volume = max(0, min(1, volume))
    var all = [main]
    if let monitor {
      if let copy = try? AVAudioPlayer(data: data) {
        if !monitor.isEmpty, let muid = outputDeviceUID(named: monitor) { copy.currentDevice = muid }
        copy.volume = 0.8
        all.append(copy)
      }
    }
    lock.lock()
    players.append(contentsOf: all)
    lock.unlock()
    all.forEach { $0.prepareToPlay() }
    let start = main.deviceCurrentTime + 0.02
    all.forEach { $0.play(atTime: start) }

    let deadline = Date().addingTimeInterval(main.duration + 10)
    Thread.sleep(forTimeInterval: 0.05)
    while main.isPlaying && Date() < deadline {
      Thread.sleep(forTimeInterval: 0.02)
    }
    all.forEach { $0.stop() }
    lock.lock()
    players.removeAll { p in all.contains { $0 === p } }
    lock.unlock()
    return nil
  }
}

/// Play WAV/MP3/AAC bytes on the output device named `device_name`. Blocks until done.
/// `monitor_name`: NULL = no copy, "" = also play on the default output, else that device too.
@_cdecl("apple_play_audio")
public func apple_play_audio(
  _ data: UnsafePointer<UInt8>?,
  _ len: Int32,
  _ device_name: UnsafePointer<CChar>?,
  _ monitor_name: UnsafePointer<CChar>?,
  _ volume: Float,
  _ err_buf: UnsafeMutablePointer<CChar>?,
  _ err_buf_len: Int32
) -> Int32 {
  guard let data, len > 0, let device_name else {
    setErr(err_buf, err_buf_len, "missing argument")
    return 1
  }
  if Thread.isMainThread {
    setErr(err_buf, err_buf_len, "play must not run on the main thread")
    return 1
  }
  let bytes = Data(bytes: data, count: Int(len))
  let monitor = monitor_name.map { String(cString: $0) }
  if let err = DevicePlayback.shared.play(
    data: bytes, device: String(cString: device_name), monitor: monitor, volume: volume)
  {
    setErr(err_buf, err_buf_len, err)
    return 2
  }
  return 0
}

@_cdecl("apple_play_stop")
public func apple_play_stop() {
  DevicePlayback.shared.stopAll()
}
