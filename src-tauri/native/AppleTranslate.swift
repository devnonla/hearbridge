import AppKit
import Foundation
import SwiftUI
import Translation

private func setCString(_ buf: UnsafeMutablePointer<CChar>?, _ len: Int32, _ msg: String) {
  guard let buf, len > 0 else { return }
  let bytes = Array(msg.utf8)
  let n = min(Int(len) - 1, bytes.count)
  for i in 0..<n { buf[i] = CChar(bitPattern: bytes[i]) }
  buf[n] = 0
}

private func normalizeLangTag(_ raw: String?) -> String {
  let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if s.isEmpty || s == "auto" { return "en" }
  return s.split(separator: "-").first.map(String.init) ?? s
}

private final class TranslateBox: @unchecked Sendable {
  var text = ""
  var err = ""
  let sem = DispatchSemaphore(value: 0)
}

@available(macOS 15.0, *)
private struct TranslateHost: View {
  let source: String
  let from: Locale.Language
  let to: Locale.Language
  let box: TranslateBox
  @State private var config: TranslationSession.Configuration?

  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .onAppear { config = .init(source: from, target: to) }
      .translationTask(config) { session in
        do {
          let response = try await session.translate(source)
          box.text = response.targetText
        } catch {
          box.err = String(describing: error)
        }
        box.sem.signal()
      }
  }
}

private let translateWindowKey: UnsafeRawPointer = UnsafeRawPointer(
  bitPattern: abs("cicada.translate.window".hashValue)
)!

@available(macOS 15.0, *)
private func runTranslation(
  text: String,
  sourceLang: String,
  targetLang: String,
  timeout: TimeInterval
) -> (String?, String?) {
  let from = Locale.Language(identifier: sourceLang)
  let to = Locale.Language(identifier: targetLang)
  let box = TranslateBox()
  var hostRef: NSHostingView<TranslateHost>?

  let attach: () -> Void = {
    let host = NSHostingView(
      rootView: TranslateHost(source: text, from: from, to: to, box: box)
    )
    host.frame = NSRect(x: 0, y: 0, width: 1, height: 1)
    host.isHidden = true
    hostRef = host

    if let anchor = NSApp.keyWindow?.contentView
      ?? NSApp.windows.first(where: \.isVisible)?.contentView
    {
      anchor.addSubview(host)
    } else {
      let win = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 2, height: 2),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
      )
      win.isReleasedWhenClosed = false
      win.alphaValue = 0
      win.contentView = host
      win.orderFrontRegardless()
      objc_setAssociatedObject(
        host, translateWindowKey, win, .OBJC_ASSOCIATION_RETAIN_NONATOMIC
      )
    }
  }

  if Thread.isMainThread { attach() }
  else { DispatchQueue.main.sync(execute: attach) }

  let deadline = Date().addingTimeInterval(timeout)
  var finished = false
  if Thread.isMainThread {
    while true {
      if box.sem.wait(timeout: .now()) == .success {
        finished = true
        break
      }
      if Date() > deadline { break }
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
  } else {
    finished = box.sem.wait(timeout: .now() + timeout) == .success
  }

  let cleanup: () -> Void = {
    guard let host = hostRef else { return }
    host.removeFromSuperview()
    if let win = objc_getAssociatedObject(host, translateWindowKey) as? NSWindow {
      win.orderOut(nil)
    }
  }
  if Thread.isMainThread { cleanup() }
  else { DispatchQueue.main.sync(execute: cleanup) }

  if !box.text.isEmpty { return (box.text, nil) }
  if finished { return (nil, box.err.isEmpty ? "Apple Translate empty" : box.err) }
  return (nil, box.err.isEmpty ? "Apple Translate timeout" : box.err)
}

@_cdecl("apple_translate_status")
public func apple_translate_status(
  _ source_lang: UnsafePointer<CChar>?,
  _ target_lang: UnsafePointer<CChar>?,
  _ out_buf: UnsafeMutablePointer<CChar>?,
  _ out_buf_len: Int32
) -> Int32 {
  let src = normalizeLangTag(source_lang.map { String(cString: $0) })
  let dst = normalizeLangTag(target_lang.map { String(cString: $0) })
  let sem = DispatchSemaphore(value: 0)
  var label = "unsupported"
  Task {
    if #available(macOS 15.0, *) {
      let status = await LanguageAvailability().status(
        from: Locale.Language(identifier: src),
        to: Locale.Language(identifier: dst)
      )
      switch status {
      case .installed: label = "installed"
      case .supported: label = "supported"
      case .unsupported: label = "unsupported"
      @unknown default: label = "unknown"
      }
    }
    sem.signal()
  }
  _ = sem.wait(timeout: .now() + 5)
  setCString(out_buf, out_buf_len, label)
  return 0
}

@_cdecl("apple_translate")
public func apple_translate(
  _ text_utf8: UnsafePointer<CChar>?,
  _ source_lang: UnsafePointer<CChar>?,
  _ target_lang: UnsafePointer<CChar>?,
  _ out_buf: UnsafeMutablePointer<CChar>?,
  _ out_buf_len: Int32,
  _ err_buf: UnsafeMutablePointer<CChar>?,
  _ err_buf_len: Int32
) -> Int32 {
  guard let text_utf8, let out_buf, out_buf_len > 1 else {
    setCString(err_buf, err_buf_len, "bad args")
    return 1
  }
  let text = String(cString: text_utf8)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty {
    setCString(err_buf, err_buf_len, "empty text")
    return 2
  }
  let src = normalizeLangTag(source_lang.map { String(cString: $0) })
  let dst = normalizeLangTag(target_lang.map { String(cString: $0) })
  if src == dst {
    setCString(out_buf, out_buf_len, text)
    return 0
  }

  guard #available(macOS 15.0, *) else {
    setCString(err_buf, err_buf_len, "Cần macOS 15+")
    return 5
  }

  let (out, err) = runTranslation(text: text, sourceLang: src, targetLang: dst, timeout: 45)
  if let out {
    let bytes = Array(out.utf8)
    if bytes.count >= Int(out_buf_len) {
      setCString(err_buf, err_buf_len, "translation quá dài")
      return 3
    }
    setCString(out_buf, out_buf_len, out)
    return 0
  }
  setCString(err_buf, err_buf_len, err ?? "Apple Translate failed")
  return 4
}
