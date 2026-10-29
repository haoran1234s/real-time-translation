//
//  AppDelegate.swift
//  TransForge 主 App 原生层（由 web/scripts/inject_ios_vision.mjs 在 cap sync 后复制到 ios/App/App/）
//
//  功能：
//  1. 端侧 Apple Vision OCR 桥接（供 Web 层上传图片识别使用）
//  2. 持续自动翻译引擎：
//     本机回环 TCP 接收录屏扩展推送的画面 → Vision OCR → 过滤 → 苹果离线翻译 / 百度翻译
//     → 渲染字幕卡片 → 画中画悬浮窗显示；静音音频保活
//

import UIKit
import WebKit
import Vision
import AVKit
import AVFoundation
import CoreMedia
import CoreVideo
import Network
import ReplayKit
import NaturalLanguage
import CryptoKit
import Capacitor
#if canImport(Translation)
import Translation
#endif

// MARK: - 数据结构

/// OCR 识别出的文本块（坐标为图片像素坐标，左上角为原点）
struct OcrLine {
    var text: String
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat
}

/// 一条翻译结果
struct TranslatedItem {
    let src: String
    let dst: String
}

// MARK: - Vision OCR 工具

/// Apple Vision 文字识别封装
enum VisionOcr {
    /// 识别语言（自动检测开启时作为候选）
    static let languages = ["en-US", "ja-JP", "ko-KR", "zh-Hans", "zh-Hant", "fr-FR", "de-DE", "es-ES", "it-IT", "pt-BR", "ru-RU"]

    /// 同步识别（请在后台队列调用）
    static func recognize(_ cgImage: CGImage) -> [OcrLine] {
        let imgW = CGFloat(cgImage.width)
        let imgH = CGFloat(cgImage.height)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        request.recognitionLanguages = languages

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }

        var lines: [OcrLine] = []
        for obs in request.results ?? [] {
            guard let top = obs.topCandidates(1).first else { continue }
            let text = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let box = obs.boundingBox
            lines.append(OcrLine(
                text: text,
                x: box.origin.x * imgW,
                y: (1.0 - box.origin.y - box.size.height) * imgH,
                w: box.size.width * imgW,
                h: box.size.height * imgH
            ))
        }
        return lines
    }

    /// 按阅读顺序把同一段落的相邻行合并为文本块
    static func mergeLines(_ lines: [OcrLine]) -> [OcrLine] {
        guard !lines.isEmpty else { return [] }
        let sorted = lines.sorted { a, b in
            if abs(a.y - b.y) < min(a.h, b.h) * 0.5 { return a.x < b.x }
            return a.y < b.y
        }
        var blocks: [OcrLine] = []
        var cur = sorted[0]
        for nxt in sorted.dropFirst() {
            let vGap = nxt.y - (cur.y + cur.h)
            let lineH = min(cur.h, nxt.h)
            let sameColumn = abs(nxt.x - cur.x) < max(lineH * 2.0, 24)
            let similarSize = max(cur.h, nxt.h) / max(1, lineH) < 1.8 || cur.h > nxt.h
            if vGap >= -lineH * 0.4 && vGap <= lineH * 0.9 && sameColumn && similarSize {
                let nx = min(cur.x, nxt.x)
                let ny = min(cur.y, nxt.y)
                let nr = max(cur.x + cur.w, nxt.x + nxt.w)
                let nb = max(cur.y + cur.h, nxt.y + nxt.h)
                let joiner = needsSpace(cur.text, nxt.text) ? " " : ""
                cur = OcrLine(text: cur.text + joiner + nxt.text, x: nx, y: ny, w: nr - nx, h: nb - ny)
            } else {
                blocks.append(cur)
                cur = nxt
            }
        }
        blocks.append(cur)
        return blocks
    }

    /// 拉丁文字合并时需要空格，CJK 不需要
    private static func needsSpace(_ a: String, _ b: String) -> Bool {
        guard let last = a.unicodeScalars.last, let first = b.unicodeScalars.first else { return false }
        return last.value < 0x2E80 && first.value < 0x2E80
    }
}

// MARK: - 苹果自带离线翻译（iOS 26+）

#if compiler(>=6.2) && canImport(Translation)
/// 苹果 Translation 框架桥接：离线、免费、无需密钥。需要用户事先在系统设置中下载语言包。
@available(iOS 26.0, *)
final class AppleTranslatorBridge {
    static let shared = AppleTranslatorBridge()

    /// 按“源语言→目标语言”缓存会话
    private var sessions: [String: TranslationSession] = [:]
    private let availability = LanguageAvailability()

    /// 逐条翻译；无法用苹果翻译的条目返回 nil（由调用方改用百度）
    func translate(_ texts: [String], targetCode: String) async -> [String?] {
        var results = [String?](repeating: nil, count: texts.count)
        guard !texts.isEmpty else { return results }

        let target = Locale.Language(identifier: targetCode)
        let fallbackLang = Self.detect(texts.joined(separator: "\n"))

        // 按检测出的源语言分组
        var groups: [String: [Int]] = [:]
        for (idx, text) in texts.enumerated() {
            let lang = (text.count >= 6 ? Self.detect(text) : nil) ?? fallbackLang
            guard let lang = lang else { continue }
            groups[lang, default: []].append(idx)
        }

        for (langId, indices) in groups {
            let source = Locale.Language(identifier: langId)
            if source.languageCode?.identifier == target.languageCode?.identifier {
                for i in indices { results[i] = texts[i] }
                continue
            }
            let status = await availability.status(from: source, to: target)
            guard status == .installed else { continue }

            let key = "\(langId)->\(targetCode)"
            let session: TranslationSession
            if let cached = sessions[key] {
                session = cached
            } else {
                session = TranslationSession(installedSource: source, target: target)
                sessions[key] = session
            }

            let requests = indices.map { TranslationSession.Request(sourceText: texts[$0], clientIdentifier: String($0)) }
            do {
                let responses = try await session.translations(from: requests)
                for resp in responses {
                    if let cid = resp.clientIdentifier, let i = Int(cid), i < results.count {
                        results[i] = resp.targetText
                    }
                }
            } catch {
                sessions[key] = nil
            }
        }
        return results
    }

    /// 使用 NaturalLanguage 检测文本语言
    private static func detect(_ text: String) -> String? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let lang = recognizer.dominantLanguage, lang != .undetermined else { return nil }
        return lang.rawValue
    }
}
#endif

// MARK: - 持续自动翻译引擎

/// 持续自动翻译引擎：回环监听 + OCR + 翻译 + 画中画
final class LiveTranslateEngine: NSObject, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate {
    static let shared = LiveTranslateEngine()

    // MARK: 常量
    /// 本机回环端口（必须与录屏扩展保持一致）
    private let port: NWEndpoint.Port = 47321
    /// 画中画画布尺寸（16:9）
    private let canvasSize = CGSize(width: 1280, height: 720)
    /// 单帧最多显示的文本块数量
    private let maxBlocks = 14
    /// 翻译缓存上限
    private let cacheLimit = 800

    // MARK: 配置（主线程写入，工作队列读取）
    private var baiduAppId: String = "__BAIDU_APP_ID__"
    private var baiduSecretKey: String = "__BAIDU_SECRET_KEY__"
    private var targetLang: String = "zh"

    // MARK: 队列
    private let netQueue = DispatchQueue(label: "transforge.live.net")
    private let workQueue = DispatchQueue(label: "transforge.live.work", qos: .userInitiated)

    // MARK: 网络（netQueue）
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    // MARK: 处理状态（workQueue）
    private var acceptFrames = false
    private var busy = false
    private var pendingFrame: Data?
    private var frameCount = 0
    private var lastSourceKey = ""
    private var cache: [String: String] = [:]
    private var cacheOrder: [String] = []
    private var recentOutputs: Set<String> = []
    private var recentOrder: [String] = []
    private var lastItems: [TranslatedItem] = []
    private var lastEngine = "-"
    private var connectedCount = 0

    // MARK: UI（主线程）
    private weak var webView: WKWebView?
    private var isActive = false
    private var wantPiP = false
    private var pipHostView: UIView?
    private var displayLayer: AVSampleBufferDisplayLayer?
    private var pipController: AVPictureInPictureController?
    private var pipPossibleObservation: NSKeyValueObservation?
    private var currentFrame: CGImage?
    private var refreshTimer: DispatchSourceTimer?
    private var silentPlayer: AVAudioPlayer?
    private var lastHint = ""

    // MARK: - 对外接口

    /// 更新配置（来自 Web 层）；目标语言变化时清空翻译缓存
    func updateConfig(baiduAppId: String?, baiduSecretKey: String?, targetLang: String?) {
        if let v = baiduAppId, !v.isEmpty { self.baiduAppId = v }
        if let v = baiduSecretKey, !v.isEmpty { self.baiduSecretKey = v }
        if let v = targetLang, !v.isEmpty, v != self.targetLang {
            self.targetLang = v
            workQueue.async {
                self.cache.removeAll()
                self.cacheOrder.removeAll()
                self.lastSourceKey = ""
            }
        }
    }

    /// 开启持续自动翻译（主线程调用）
    func start(webView: WKWebView?) {
        self.webView = webView
        isActive = true
        wantPiP = true
        lastHint = ""

        startSilentAudio()
        setupPiPIfNeeded()
        startListener()
        workQueue.async {
            self.acceptFrames = true
            self.lastSourceKey = ""
        }

        showStatusCard(title: "等待录屏开始", subtitle: "请在弹出的系统窗口中点「开始直播」，然后切到任意 App，停留 1～2 秒即可看到译文")
        startRefreshTimer()
        tryStartPiP()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.presentBroadcastPicker()
        }
        notifyWeb()
    }

    /// 关闭持续自动翻译（主线程调用）
    func stop() {
        isActive = false
        wantPiP = false
        workQueue.async {
            self.acceptFrames = false
            self.pendingFrame = nil
        }
        stopListener()
        refreshTimer?.cancel()
        refreshTimer = nil
        if let pip = pipController, pip.isPictureInPictureActive {
            pip.stopPictureInPicture()
        }
        silentPlayer?.stop()
        silentPlayer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        notifyWeb()
    }

    /// 重新弹出系统录屏选择器
    func presentBroadcastPicker() {
        guard let root = Self.keyWindow()?.rootViewController?.view else { return }
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: -100, y: -100, width: 44, height: 44))
        picker.showsMicrophoneButton = false
        picker.preferredExtension = Self.findBroadcastExtensionId()
        picker.alpha = 0.01
        root.addSubview(picker)
        if let button = Self.findButton(in: picker) {
            button.sendActions(for: .touchUpInside)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            picker.removeFromSuperview()
        }
    }

    // MARK: - 静音音频保活

    /// 播放循环静音音频，使 App 在后台保持运行（与其他 App 的声音混音，不打断游戏/音乐）
    private func startSilentAudio() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            sendHint("音频会话启动失败，后台可能无法持续翻译")
        }
        if silentPlayer == nil, let player = try? AVAudioPlayer(data: Self.makeSilentWav()) {
            player.numberOfLoops = -1
            player.volume = 0.0
            player.prepareToPlay()
            silentPlayer = player
        }
        silentPlayer?.play()

        NotificationCenter.default.removeObserver(self, name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(handleAudioInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    /// 音频被打断结束后恢复保活
    @objc private func handleAudioInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw),
              type == .ended else { return }
        DispatchQueue.main.async {
            guard self.isActive else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            self.silentPlayer?.play()
        }
    }

    /// 生成 1 秒静音 WAV（8kHz 单声道 16bit）
    private static func makeSilentWav() -> Data {
        let sampleRate: UInt32 = 8000
        let numSamples: UInt32 = 8000
        let dataSize = numSamples * 2
        var data = Data()
        func append<T>(_ value: T) {
            var v = value
            withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: Array("RIFF".utf8))
        append(UInt32(36 + dataSize).littleEndian)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        append(UInt32(16).littleEndian)
        append(UInt16(1).littleEndian)
        append(UInt16(1).littleEndian)
        append(sampleRate.littleEndian)
        append((sampleRate * 2).littleEndian)
        append(UInt16(2).littleEndian)
        append(UInt16(16).littleEndian)
        data.append(contentsOf: Array("data".utf8))
        append(dataSize.littleEndian)
        data.append(Data(count: Int(dataSize)))
        return data
    }

    // MARK: - 回环监听（netQueue）

    /// 启动本机回环 TCP 监听
    private func startListener() {
        netQueue.async {
            guard self.listener == nil else { return }
            do {
                let params = NWParameters.tcp
                params.allowLocalEndpointReuse = true
                params.requiredInterfaceType = .loopback
                let l = try NWListener(using: params, on: self.port)
                l.newConnectionHandler = { [weak self] conn in
                    self?.accept(conn)
                }
                l.stateUpdateHandler = { [weak self] state in
                    if case .failed = state {
                        self?.sendHint("本机监听失败，请关闭后重新开启实时翻译")
                        self?.netQueue.async {
                            self?.listener?.cancel()
                            self?.listener = nil
                        }
                    }
                }
                l.start(queue: self.netQueue)
                self.listener = l
            } catch {
                self.sendHint("本机监听启动失败：\(error.localizedDescription)")
            }
        }
    }

    /// 停止监听并通知录屏扩展结束
    private func stopListener() {
        netQueue.async {
            let stopData = Data("STOP".utf8)
            for conn in self.connections.values {
                conn.send(content: stopData, completion: .contentProcessed { _ in
                    conn.cancel()
                })
            }
            self.connections.removeAll()
            self.listener?.cancel()
            self.listener = nil
            self.updateConnectedCount()
        }
    }

    /// 接受录屏扩展的连接
    private func accept(_ conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        connections[id] = conn
        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard let self = self, let conn = conn else { return }
            switch state {
            case .failed, .cancelled:
                self.connections[ObjectIdentifier(conn)] = nil
                self.updateConnectedCount()
            default:
                break
            }
        }
        conn.start(queue: netQueue)
        updateConnectedCount()
        receiveHeader(conn)
    }

    /// 读取 4 字节长度头
    private func receiveHeader(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, data.count == 4 {
                let length = data.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                guard length > 0, length < 8_000_000 else {
                    conn.cancel()
                    return
                }
                self.receiveBody(conn, length: Int(length))
            } else if isComplete || error != nil {
                conn.cancel()
            } else {
                self.receiveHeader(conn)
            }
        }
    }

    /// 读取图片数据
    private func receiveBody(_ conn: NWConnection, length: Int) {
        conn.receive(minimumIncompleteLength: length, maximumLength: length) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, data.count == length {
                self.enqueueFrame(data)
                self.receiveHeader(conn)
            } else if isComplete || error != nil {
                conn.cancel()
            } else {
                conn.cancel()
            }
        }
    }

    /// 更新连接数并通知界面（netQueue 调用）
    private func updateConnectedCount() {
        let count = connections.count
        workQueue.async {
            let changed = self.connectedCount != count
            self.connectedCount = count
            guard changed else { return }
            DispatchQueue.main.async {
                guard self.isActive else { return }
                if count > 0 {
                    self.showStatusCard(title: "录屏已连接", subtitle: "切到任意外文 App，画面停稳 1～2 秒后这里会自动显示译文")
                } else {
                    self.showStatusCard(title: "录屏已断开", subtitle: "可在 App 内点「重新弹出录屏开关」，或在控制中心长按「屏幕录制」选择 TransForge")
                }
                self.notifyWeb()
            }
        }
    }

    // MARK: - 帧处理流水线（workQueue）

    /// 收到新画面：只保留最新一帧，处理中时丢弃旧帧
    private func enqueueFrame(_ data: Data) {
        workQueue.async {
            guard self.acceptFrames else { return }
            self.frameCount += 1
            self.pendingFrame = data
            self.pump()
        }
    }

    private func pump() {
        guard !busy, let data = pendingFrame else { return }
        pendingFrame = nil
        busy = true
        processFrame(data) { [weak self] in
            self?.workQueue.async {
                self?.busy = false
                self?.pump()
            }
        }
    }

    /// OCR → 过滤 → 合并 → 翻译 → 渲染
    private func processFrame(_ data: Data, done: @escaping () -> Void) {
        guard let image = UIImage(data: data), let cgImage = image.cgImage else {
            done()
            return
        }

        let rawLines = VisionOcr.recognize(cgImage).filter { shouldKeep($0.text) }
        var blocks = VisionOcr.mergeLines(rawLines)
        if blocks.count > maxBlocks {
            blocks = Array(blocks.prefix(maxBlocks))
        }

        let sources = blocks.map { $0.text }
        let key = sources.joined(separator: "\u{1}")
        guard key != lastSourceKey else {
            done()
            return
        }
        lastSourceKey = key

        if sources.isEmpty {
            lastItems = []
            DispatchQueue.main.async {
                self.showStatusCard(title: "当前画面没有需要翻译的文字", subtitle: "切到含外文的界面，停稳 1～2 秒即可自动识别")
                self.notifyWeb()
            }
            done()
            return
        }

        translate(sources) { [weak self] translated, engine in
            guard let self = self else {
                done()
                return
            }
            self.workQueue.async {
                var items: [TranslatedItem] = []
                for (i, src) in sources.enumerated() {
                    let dst = i < translated.count ? translated[i] : src
                    items.append(TranslatedItem(src: src, dst: dst))
                    self.rememberOutput(dst)
                }
                self.lastItems = items
                self.lastEngine = engine
                let total = self.frameCount
                DispatchQueue.main.async {
                    self.showTranslationCard(items: items, engine: engine, frames: total)
                    self.notifyWeb()
                }
                done()
            }
        }
    }

    /// 过滤：纯数字/符号、已是目标语言的文字、本 App 刚输出的译文（避免画中画被录进去后“翻译自己”）
    private func shouldKeep(_ raw: String) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return false }
        if recentOutputs.contains(Self.normalize(text)) { return false }

        var han = 0, kana = 0, hangul = 0, latin = 0, other = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
                han += 1
            case 0x3040...0x30FF, 0x31F0...0x31FF:
                kana += 1
            case 0xAC00...0xD7AF, 0x1100...0x11FF, 0x3130...0x318F:
                hangul += 1
            case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F:
                latin += 1
            case 0x0400...0x04FF:
                other += 1
            default:
                break
            }
        }
        let letters = han + kana + hangul + latin + other
        guard letters >= 2 else { return false }

        switch targetLang {
        case "zh":
            if han > 0 && kana == 0 && hangul == 0 && latin * 2 < han { return false }
        case "ja":
            if kana > 0 { return false }
        case "en":
            if latin == letters { return false }
        default:
            break
        }
        return true
    }

    /// 记录最近输出的译文
    private func rememberOutput(_ text: String) {
        let key = Self.normalize(text)
        guard !key.isEmpty, !recentOutputs.contains(key) else { return }
        recentOutputs.insert(key)
        recentOrder.append(key)
        if recentOrder.count > 300 {
            let removed = recentOrder.removeFirst()
            recentOutputs.remove(removed)
        }
    }

    private static func normalize(_ text: String) -> String {
        return text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation }
    }

    // MARK: - 翻译（缓存 → 苹果离线 → 百度）

    /// 翻译一组文本；completion 回调的 engine 为本次实际使用的引擎名称
    private func translate(_ texts: [String], completion: @escaping ([String], String) -> Void) {
        var results = [String?](repeating: nil, count: texts.count)
        var missing: [Int] = []
        for (i, t) in texts.enumerated() {
            if let hit = cache[t] {
                results[i] = hit
            } else {
                missing.append(i)
            }
        }
        if missing.isEmpty {
            completion(results.map { $0 ?? "" }, lastEngine == "-" ? "缓存" : lastEngine)
            return
        }

        let missingTexts = missing.map { texts[$0] }
        let target = targetLang

        let finish: ([String?], String) -> Void = { [weak self] partial, engine in
            guard let self = self else { return }
            self.workQueue.async {
                for (k, idx) in missing.enumerated() {
                    if let dst = partial[k], !dst.isEmpty {
                        results[idx] = dst
                        self.storeCache(texts[idx], dst)
                    }
                }
                completion(results.enumerated().map { $0.element ?? texts[$0.offset] }, engine)
            }
        }

        #if compiler(>=6.2) && canImport(Translation)
        if #available(iOS 26.0, *) {
            let appleTarget = Self.appleLanguageCode(target)
            Task {
                let appleOut = await AppleTranslatorBridge.shared.translate(missingTexts, targetCode: appleTarget)
                let stillMissing = appleOut.enumerated().filter { $0.element == nil }.map { $0.offset }
                if stillMissing.isEmpty {
                    finish(appleOut, "苹果离线")
                    return
                }
                let baiduTexts = stillMissing.map { missingTexts[$0] }
                self.translateBaidu(baiduTexts, target: target) { baiduOut in
                    var merged = appleOut
                    for (k, idx) in stillMissing.enumerated() where k < baiduOut.count {
                        merged[idx] = baiduOut[k]
                    }
                    let usedApple = stillMissing.count < missingTexts.count
                    if baiduOut.isEmpty {
                        self.sendHint("部分语言未下载离线包且百度不可用：设置 → App → 翻译 → 下载语言")
                    }
                    finish(merged, usedApple ? "苹果离线+百度" : "百度")
                }
            }
            return
        }
        #endif

        translateBaidu(missingTexts, target: target) { out in
            let mapped: [String?] = missingTexts.indices.map { $0 < out.count ? out[$0] : nil }
            finish(mapped, out.isEmpty ? "未翻译" : "百度")
        }
    }

    private func storeCache(_ src: String, _ dst: String) {
        if cache[src] == nil {
            cacheOrder.append(src)
            if cacheOrder.count > cacheLimit {
                let old = cacheOrder.removeFirst()
                cache[old] = nil
            }
        }
        cache[src] = dst
    }

    private static func appleLanguageCode(_ code: String) -> String {
        switch code {
        case "zh": return "zh-Hans"
        default: return code
        }
    }

    /// 百度通用翻译 API；失败时回调空数组
    private func translateBaidu(_ texts: [String], target: String, completion: @escaping ([String]) -> Void) {
        let appId = baiduAppId
        let secret = baiduSecretKey
        guard !texts.isEmpty, !appId.isEmpty, !secret.isEmpty, !appId.hasPrefix("__") else {
            completion([])
            return
        }
        let langMap = ["zh": "zh", "en": "en", "ja": "jp", "ko": "kor", "fr": "fra", "es": "spa", "de": "de", "ru": "ru"]
        let to = langMap[target] ?? "zh"
        let cleaned = texts.map { $0.replacingOccurrences(of: "\n", with: " ") }
        let query = cleaned.joined(separator: "\n")
        let salt = String(Int(Date().timeIntervalSince1970 * 1000))
        let digest = Insecure.MD5.hash(data: Data((appId + query + salt + secret).utf8))
        let sign = digest.map { String(format: "%02hhx", $0) }.joined()

        guard let url = URL(string: "https://fanyi-api.baidu.com/api/trans/vip/translate") else {
            completion([])
            return
        }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")
        var comps = URLComponents()
        comps.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "from", value: "auto"),
            URLQueryItem(name: "to", value: to),
            URLQueryItem(name: "appid", value: appId),
            URLQueryItem(name: "salt", value: salt),
            URLQueryItem(name: "sign", value: sign)
        ]
        // URLComponents 不会编码 "+"，百度会把它当空格，需手动编码
        let body = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        req.httpBody = body.data(using: .utf8)

        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            guard error == nil,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion([])
                return
            }
            if let code = json["error_code"] {
                self?.sendHint("百度翻译错误：\(code)")
                completion([])
                return
            }
            guard let list = json["trans_result"] as? [[String: Any]] else {
                completion([])
                return
            }
            let out = cleaned.indices.map { i -> String in
                if i < list.count, let dst = list[i]["dst"] as? String { return dst }
                return cleaned[i]
            }
            completion(out)
        }.resume()
    }

    // MARK: - 画中画（主线程）

    /// 初始化画中画控制器
    private func setupPiPIfNeeded() {
        guard pipController == nil, AVPictureInPictureController.isPictureInPictureSupported() else {
            if !AVPictureInPictureController.isPictureInPictureSupported() {
                sendHint("当前设备不支持画中画")
            }
            return
        }
        guard let root = Self.keyWindow()?.rootViewController?.view else { return }

        // 画中画源视图需要在视图层级中且可见，这里放在左上角状态栏区域，尺寸极小
        let host = UIView(frame: CGRect(x: 0, y: 0, width: 32, height: 18))
        host.isUserInteractionEnabled = false
        host.backgroundColor = .clear
        root.addSubview(host)
        pipHostView = host

        let layer = AVSampleBufferDisplayLayer()
        layer.frame = host.bounds
        layer.videoGravity = .resizeAspect
        host.layer.addSublayer(layer)
        displayLayer = layer

        let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: layer, playbackDelegate: self)
        let controller = AVPictureInPictureController(contentSource: source)
        controller.delegate = self
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        pipController = controller

        pipPossibleObservation = controller.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, change in
            guard change.newValue == true else { return }
            DispatchQueue.main.async {
                self?.tryStartPiP()
            }
        }
    }

    /// 在可行时启动画中画
    private func tryStartPiP() {
        guard wantPiP, let pip = pipController, !pip.isPictureInPictureActive else { return }
        if pip.isPictureInPicturePossible {
            pip.startPictureInPicture()
        }
    }

    /// 每秒重新推送当前帧，保持画中画处于“播放中”
    private func startRefreshTimer() {
        refreshTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1.0, repeating: 1.0)
        timer.setEventHandler { [weak self] in
            self?.enqueueCurrentFrame()
        }
        timer.resume()
        refreshTimer = timer
    }

    private func enqueueCurrentFrame() {
        guard let layer = displayLayer, let frame = currentFrame, let buffer = Self.makeSampleBuffer(from: frame) else { return }
        if layer.status == .failed {
            layer.flush()
        }
        layer.enqueue(buffer)
    }

    private func setFrame(_ image: CGImage?) {
        guard let image = image else { return }
        currentFrame = image
        enqueueCurrentFrame()
    }

    // MARK: - 字幕卡片渲染（主线程调用，内部绘制）

    private func showStatusCard(title: String, subtitle: String) {
        setFrame(renderCard(title: title, subtitle: subtitle, items: [], engine: nil))
    }

    private func showTranslationCard(items: [TranslatedItem], engine: String, frames: Int) {
        setFrame(renderCard(title: nil, subtitle: nil, items: items, engine: engine))
    }

    /// 绘制 1280x720 字幕卡片。卡片内只出现中文与数字，避免被录屏后再次识别翻译。
    private func renderCard(title: String?, subtitle: String?, items: [TranslatedItem], engine: String?) -> CGImage? {
        let size = canvasSize
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let accent = UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 1.0)

        let image = renderer.image { ctx in
            UIColor(red: 0.043, green: 0.047, blue: 0.063, alpha: 1.0).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))

            // 顶栏
            let dotRect = CGRect(x: 36, y: 30, width: 18, height: 18)
            accent.setFill()
            UIBezierPath(ovalIn: dotRect).fill()
            let headAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 26, weight: .bold),
                .foregroundColor: accent
            ]
            ("实时翻译中" as NSString).draw(at: CGPoint(x: 66, y: 22), withAttributes: headAttrs)

            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            let right = "\(engine ?? "等待中") · \(formatter.string(from: Date()))"
            let rightAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 22, weight: .medium),
                .foregroundColor: UIColor(white: 0.62, alpha: 1.0)
            ]
            let rightSize = (right as NSString).size(withAttributes: rightAttrs)
            (right as NSString).draw(at: CGPoint(x: size.width - 36 - rightSize.width, y: 26), withAttributes: rightAttrs)

            UIColor(white: 1.0, alpha: 0.08).setFill()
            ctx.fill(CGRect(x: 36, y: 72, width: size.width - 72, height: 2))

            let contentRect = CGRect(x: 48, y: 96, width: size.width - 96, height: size.height - 120)

            if items.isEmpty {
                let titleAttrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: 48, weight: .heavy),
                    .foregroundColor: UIColor.white
                ]
                ((title ?? "") as NSString).draw(in: CGRect(x: contentRect.minX, y: contentRect.minY + 40, width: contentRect.width, height: 140), withAttributes: titleAttrs)
                let para = NSMutableParagraphStyle()
                para.lineSpacing = 8
                let subAttrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.systemFont(ofSize: 30, weight: .medium),
                    .foregroundColor: UIColor(white: 0.72, alpha: 1.0),
                    .paragraphStyle: para
                ]
                ((subtitle ?? "") as NSString).draw(in: CGRect(x: contentRect.minX, y: contentRect.minY + 180, width: contentRect.width, height: contentRect.height - 180), withAttributes: subAttrs)
                return
            }

            // 自适应字号：从大到小尝试，直到全部放下
            let texts = items.map { $0.dst }
            var fontSize: CGFloat = 46
            let minFont: CGFloat = 24
            let spacing: CGFloat = 14
            var heights: [CGFloat] = []
            var attrs: [NSAttributedString.Key: Any] = [:]
            while true {
                let para = NSMutableParagraphStyle()
                para.lineSpacing = fontSize * 0.18
                attrs = [
                    .font: UIFont.systemFont(ofSize: fontSize, weight: .bold),
                    .foregroundColor: UIColor.white,
                    .paragraphStyle: para
                ]
                heights = texts.map {
                    ($0 as NSString).boundingRect(
                        with: CGSize(width: contentRect.width - 28, height: .greatestFiniteMagnitude),
                        options: [.usesLineFragmentOrigin, .usesFontLeading],
                        attributes: attrs,
                        context: nil
                    ).height.rounded(.up)
                }
                let total = heights.reduce(0, +) + spacing * CGFloat(max(0, texts.count - 1))
                if total <= contentRect.height || fontSize <= minFont { break }
                fontSize -= 2
            }

            var y = contentRect.minY
            for (i, text) in texts.enumerated() {
                let h = heights[i]
                if y + min(h, fontSize * 1.3) > contentRect.maxY {
                    let moreAttrs: [NSAttributedString.Key: Any] = [
                        .font: UIFont.systemFont(ofSize: 24, weight: .medium),
                        .foregroundColor: UIColor(white: 0.6, alpha: 1.0)
                    ]
                    ("……还有 \(texts.count - i) 条，打开 App 查看全部" as NSString).draw(at: CGPoint(x: contentRect.minX, y: contentRect.maxY - 30), withAttributes: moreAttrs)
                    break
                }
                accent.withAlphaComponent(0.85).setFill()
                ctx.fill(CGRect(x: contentRect.minX, y: y + 6, width: 6, height: max(fontSize, min(h, contentRect.maxY - y) - 12)))
                let drawH = min(h, contentRect.maxY - y)
                (text as NSString).draw(
                    with: CGRect(x: contentRect.minX + 24, y: y, width: contentRect.width - 28, height: drawH),
                    options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine],
                    attributes: attrs,
                    context: nil
                )
                y += h + spacing
            }
        }
        return image.cgImage
    }

    /// 把 CGImage 转为可推送给 AVSampleBufferDisplayLayer 的 CMSampleBuffer
    private static func makeSampleBuffer(from image: CGImage) -> CMSampleBuffer? {
        let width = image.width
        let height = image.height
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()
        ]
        var pixelBufferOut: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &pixelBufferOut) == kCVReturnSuccess,
              let pixelBuffer = pixelBufferOut else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        let drawn: Bool = {
            guard let base = CVPixelBufferGetBaseAddress(pixelBuffer),
                  let ctx = CGContext(
                    data: base,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
                  ) else { return false }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }()
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        guard drawn else { return nil }

        var formatDesc: CMVideoFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer, formatDescriptionOut: &formatDesc) == noErr,
              let desc = formatDesc else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 1),
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            decodeTimeStamp: .invalid
        )
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: desc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBuffer
        ) == noErr, let sb = sampleBuffer else { return nil }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: true) as? [NSMutableDictionary],
           let first = attachments.first {
            first[kCMSampleAttachmentKey_DisplayImmediately] = kCFBooleanTrue
        }
        return sb
    }

    // MARK: - AVPictureInPictureControllerDelegate

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        notifyWeb()
    }

    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        notifyWeb()
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        sendHint("画中画启动失败：\(error.localizedDescription)")
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }

    // MARK: - AVPictureInPictureSampleBufferPlaybackDelegate

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {}

    func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
        return CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
    }

    func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
        return false
    }

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    // MARK: - Web 层通知

    /// 推送一条提示文字到 Web 层
    private func sendHint(_ text: String) {
        DispatchQueue.main.async {
            self.lastHint = text
            self.notifyWeb()
        }
    }

    /// 把当前状态推送给 Web 层（主线程调用）
    private func notifyWeb() {
        let active = isActive
        let pipOn = pipController?.isPictureInPictureActive ?? false
        let hint = lastHint
        workQueue.async {
            let payload: [String: Any] = [
                "active": active,
                "pip": pipOn,
                "connected": self.connectedCount > 0,
                "frames": self.frameCount,
                "engine": self.lastEngine,
                "hint": hint,
                "items": self.lastItems.prefix(20).map { ["src": $0.src, "dst": $0.dst] }
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript("window.__onLiveState && window.__onLiveState(\(json));", completionHandler: nil)
            }
        }
    }

    // MARK: - 工具

    static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }

    /// 从 App 的 PlugIns 目录中找到录屏扩展的 Bundle ID（自签工具可能修改 Bundle ID，因此运行时读取）
    private static func findBroadcastExtensionId() -> String? {
        guard let url = Bundle.main.builtInPlugInsURL,
              let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else { return nil }
        for item in items where item.pathExtension == "appex" {
            guard let bundle = Bundle(url: item),
                  let ext = bundle.infoDictionary?["NSExtension"] as? [String: Any],
                  (ext["NSExtensionPointIdentifier"] as? String) == "com.apple.broadcast-services-upload" else { continue }
            return bundle.bundleIdentifier
        }
        return nil
    }

    /// 递归查找系统录屏选择器内部的按钮
    private static func findButton(in view: UIView) -> UIButton? {
        if let button = view as? UIButton { return button }
        for sub in view.subviews {
            if let found = findButton(in: sub) { return found }
        }
        return nil
    }
}

// MARK: - Web 消息桥接

/// 处理 Web 层通过 window.webkit.messageHandlers.nativeOcr 发来的消息
final class VisionOcrHandler: NSObject, WKScriptMessageHandler {
    static let shared = VisionOcrHandler()
    private var attachedWebViews = NSHashTable<WKWebView>.weakObjects()

    func attachIfNeeded(to webView: WKWebView) {
        guard !attachedWebViews.contains(webView) else { return }
        attachedWebViews.add(webView)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeOcr")
        webView.configuration.userContentController.add(self, name: "nativeOcr")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeOcr",
              let body = message.body as? [String: Any],
              let webView = message.webView else { return }

        let engine = LiveTranslateEngine.shared
        engine.updateConfig(
            baiduAppId: body["baiduAppId"] as? String,
            baiduSecretKey: body["baiduSecretKey"] as? String,
            targetLang: body["targetLang"] as? String
        )

        switch (body["action"] as? String) ?? "ocr" {
        case "startLive":
            engine.start(webView: webView)
        case "stopLive":
            engine.stop()
        case "openPicker":
            engine.presentBroadcastPicker()
        case "config":
            break
        default:
            handleOcr(body: body, webView: webView)
        }
    }

    /// 对 Web 层传入的图片执行 OCR 并回调
    private func handleOcr(body: [String: Any], webView: WKWebView) {
        guard let callbackId = body["callbackId"] as? String,
              let base64Str = body["imageBase64"] as? String else { return }
        let clean = base64Str.range(of: ",").map { String(base64Str[$0.upperBound...]) } ?? base64Str

        DispatchQueue.global(qos: .userInitiated).async {
            var lines: [[String: Any]] = []
            if let data = Data(base64Encoded: clean, options: .ignoreUnknownCharacters),
               let image = UIImage(data: data),
               let cg = image.cgImage {
                lines = VisionOcr.recognize(cg).map { l in
                    ["text": l.text, "x": Double(l.x), "y": Double(l.y), "w": Double(l.w), "h": Double(l.h)]
                }
            }
            guard let json = try? JSONSerialization.data(withJSONObject: lines),
                  let jsonStr = String(data: json, encoding: .utf8) else { return }
            let safeId = callbackId.replacingOccurrences(of: "'", with: "")
            DispatchQueue.main.async {
                webView.evaluateJavaScript("window.__onNativeOcrResult && window.__onNativeOcrResult('\(safeId)', \(jsonStr));", completionHandler: nil)
            }
        }
    }
}

// MARK: - AppDelegate

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    private func bindBridge() {
        if let vc = self.window?.rootViewController as? CAPBridgeViewController,
           let wv = vc.webView {
            VisionOcrHandler.shared.attachIfNeeded(to: wv)
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.bindBridge()
        }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        bindBridge()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
