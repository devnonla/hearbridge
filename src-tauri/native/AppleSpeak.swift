import AVFoundation
import Foundation

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
