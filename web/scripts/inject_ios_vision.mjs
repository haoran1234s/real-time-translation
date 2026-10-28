/**
 * 向 Capacitor 生成的 iOS 工程注入：
 * 1. Apple Vision 原生硬件级 OCR 桥接器 (VNRecognizeTextRequest)
 * 2. iOS 全局画中画悬浮窗 (AVPictureInPictureController + AVSampleBufferDisplayLayer)
 * 3. 后台相册新截屏实时监听器 (PHPhotoLibraryChangeObserver) + 剪贴板实时监听
 * 4. 原生后台百度翻译 API 调用 + 1:1 原位图像覆盖渲染器 (即使 WebView 处于后台也能秒级实时刷新悬浮窗)
 */

import fs from "node:fs";
import path from "node:path";

const appDelegatePath = path.join(process.cwd(), "ios", "App", "App", "AppDelegate.swift");

if (!fs.existsSync(appDelegatePath)) {
  console.log("[SKIP] ios/App/App/AppDelegate.swift 尚未生成，跳过注入");
  process.exit(0);
}

const swiftCode = `import UIKit
import WebKit
import Vision
import AVKit
import AVFoundation
import CoreMedia
import CoreVideo
import Photos
import CryptoKit
import Capacitor

/// OCR 识别与译文坐标框数据结构
struct OcrLineBox {
    var text: String
    var dst: String
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat
}

/// iOS 原生 Apple Vision OCR + 全局画中画 (PiP) 实时悬浮翻译引擎
final class VisionOcrHandler: NSObject, WKScriptMessageHandler, AVPictureInPictureControllerDelegate, AVPictureInPictureSampleBufferPlaybackDelegate, PHPhotoLibraryChangeObserver {
    static let shared = VisionOcrHandler()
    private var attachedWebViews = NSHashTable<WKWebView>.weakObjects()

    // 画中画 (PiP) 与后台保活组件
    private var sampleLayer: AVSampleBufferDisplayLayer?
    private var pipHostView: UIView?
    private var pipController: AVPictureInPictureController?
    private var pipFeedTimer: Timer?
    private var currentPiPImage: UIImage?
    private var isLiveModeActive: Bool = false

    // 后台自动监听截屏与剪贴板状态
    private var lastProcessedAssetId: String = ""
    private var monitoringStartDate: Date = Date()
    private var lastPasteboardCount: Int = UIPasteboard.general.changeCount
    private var isProcessingAutoTask: Bool = false

    // 百度翻译 API 凭证（支持从前端动态同步或使用预设值）
    private var baiduAppId: String = "${process.env.BAIDU_TRANSLATE_APP_ID || ""}"
    private var baiduSecretKey: String = "${process.env.BAIDU_TRANSLATE_SECRET_KEY || ""}"
    private var targetLang: String = "zh"

    func attachIfNeeded(to webView: WKWebView) {
        guard !attachedWebViews.contains(webView) else { return }
        attachedWebViews.add(webView)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "nativeOcr")
        webView.configuration.userContentController.add(self, name: "nativeOcr")
    }

    // MARK: - WKScriptMessageHandler 消息分发
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "nativeOcr",
              let body = message.body as? [String: Any],
              let webView = message.webView else {
            return
        }

        // 同步百度翻译凭证与目标语言
        if let aid = body["baiduAppId"] as? String, !aid.isEmpty { self.baiduAppId = aid }
        if let sk = body["baiduSecretKey"] as? String, !sk.isEmpty { self.baiduSecretKey = sk }
        if let tl = body["targetLang"] as? String, !tl.isEmpty { self.targetLang = tl }

        let action = (body["action"] as? String) ?? "ocr"

        if action == "startPiP" {
            startLivePiPMode(webView: webView)
            return
        } else if action == "stopPiP" {
            stopLivePiPMode(webView: webView)
            return
        } else if action == "updatePiPFrame" {
            if let b64 = body["imageBase64"] as? String, let img = decodeBase64Image(b64) {
                self.currentPiPImage = img
                enqueueCurrentPiPFrame()
            }
            return
        } else if action == "translateLatestScreenshot" {
            checkLatestScreenshot(forceTranslateLatest: true)
            return
        }

        // 默认动作：对传入的 base64 图片执行端侧 Apple Vision OCR
        guard let callbackId = body["callbackId"] as? String,
              let base64Str = body["imageBase64"] as? String else {
            return
        }

        guard let uiImage = decodeBase64Image(base64Str),
              let cgImage = uiImage.cgImage else {
            sendOcrResult(to: webView, callbackId: callbackId, lines: [])
            return
        }

        runVisionOcr(on: cgImage) { [weak self] boxes in
            let dictLines = boxes.map { b -> [String: Any] in
                return [
                    "text": b.text,
                    "x": (Double(b.x) * 10).rounded() / 10,
                    "y": (Double(b.y) * 10).rounded() / 10,
                    "w": (Double(b.w) * 10).rounded() / 10,
                    "h": (Double(b.h) * 10).rounded() / 10
                ]
            }
            self?.sendOcrResult(to: webView, callbackId: callbackId, lines: dictLines)
        }
    }

    // MARK: - 启动 / 关闭全局画中画 (PiP) 实时悬浮翻译模式
    private func startLivePiPMode(webView: WKWebView) {
        DispatchQueue.main.async {
            self.isLiveModeActive = true
            self.monitoringStartDate = Date()
            self.lastPasteboardCount = UIPasteboard.general.changeCount

            // 1. 配置后台混音音频会话（不打断当前游戏/App音乐，同时保持后台运行活性）
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
            try? session.setActive(true)

            // 2. 请求相册读取权限并注册新截屏实时观察者
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                if status == .authorized || status == .limited {
                    self.recordInitialScreenshotId()
                    PHPhotoLibrary.shared().register(self)
                }
            }

            // 3. 初始化画中画渲染层与控制器
            self.setupPiPControllerIfNeeded()

            // 4. 生成初始欢迎引导帧并推流
            if self.currentPiPImage == nil {
                self.currentPiPImage = self.renderStatusCard(
                    badge: "LIVE · 实时悬浮翻译已开启",
                    title: "切回任意 App 即可实时翻译",
                    subtitle: "方式1：在任意 App 中截屏（推荐设置「轻敲背面两下 -> 截屏」），悬浮窗将在 0.5 秒内自动识别并显示 1:1 原位译文\\n\\n方式2：在任意 App 中复制外文段落，悬浮窗自动实时翻译",
                    accentColor: UIColor(red: 0.06, green: 0.72, blue: 0.50, alpha: 1.0)
                )
            }
            self.enqueueCurrentPiPFrame()

            // 5. 启动后台保活推流与截屏/剪贴板轮询定时器
            self.pipFeedTimer?.invalidate()
            let timer = Timer(timeInterval: 0.7, repeats: true) { [weak self] _ in
                guard let self = self, self.isLiveModeActive else { return }
                self.enqueueCurrentPiPFrame()
                self.checkClipboardChange()
                self.checkLatestScreenshot(forceTranslateLatest: false)
            }
            RunLoop.main.add(timer, forMode: .common)
            self.pipFeedTimer = timer

            // 6. 延迟 0.25s 启动画中画悬浮窗
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                if let pip = self.pipController, !pip.isPictureInPictureActive {
                    pip.startPictureInPicture()
                }
                self.notifyWebPiPState(active: true, message: "画中画实时悬浮窗已启动，切回任意App截屏或复制即自动翻译")
            }
        }
    }

    private func stopLivePiPMode(webView: WKWebView) {
        DispatchQueue.main.async {
            self.isLiveModeActive = false
            self.pipFeedTimer?.invalidate()
            self.pipFeedTimer = nil
            PHPhotoLibrary.shared().unregisterChangeObserver(self)
            if let pip = self.pipController, pip.isPictureInPictureActive {
                pip.stopPictureInPicture()
            }
            self.notifyWebPiPState(active: false, message: "已关闭全局画中画实时翻译模式")
        }
    }

    private func setupPiPControllerIfNeeded() {
        guard self.pipController == nil else { return }
        guard let window = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first,
              let rootView = window.rootViewController?.view else {
            return
        }

        let hostView = UIView(frame: CGRect(x: 0, y: 0, width: 180, height: 320))
        hostView.alpha = 0.01
        hostView.isUserInteractionEnabled = false
        rootView.addSubview(hostView)
        self.pipHostView = hostView

        let layer = AVSampleBufferDisplayLayer()
        layer.frame = hostView.bounds
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = UIColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1.0).cgColor
        hostView.layer.addSublayer(layer)
        self.sampleLayer = layer

        if AVPictureInPictureController.isPictureInPictureSupported() {
            let source = AVPictureInPictureController.ContentSource(
                sampleBufferDisplayLayer: layer,
                playbackDelegate: self
            )
            let controller = AVPictureInPictureController(contentSource: source)
            controller.delegate = self
            if #available(iOS 14.2, *) {
                controller.canStartPictureInPictureAutomaticallyFromInline = true
            }
            self.pipController = controller
        }
    }

    // MARK: - 相册新截屏实时检测 (PHPhotoLibraryChangeObserver)
    func photoLibraryDidChange(_ changeInstance: PHChange) {
        guard isLiveModeActive else { return }
        checkLatestScreenshot(forceTranslateLatest: false)
    }

    private func recordInitialScreenshotId() {
        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = 1
        let assets = PHAsset.fetchAssets(with: .image, options: opts)
        if let first = assets.firstObject {
            self.lastProcessedAssetId = first.localIdentifier
        }
    }

    private func checkLatestScreenshot(forceTranslateLatest: Bool) {
        guard !isProcessingAutoTask else { return }
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else { return }

        let opts = PHFetchOptions()
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        opts.fetchLimit = 1
        let assets = PHAsset.fetchAssets(with: .image, options: opts)
        guard let asset = assets.firstObject else { return }

        if !forceTranslateLatest {
            if asset.localIdentifier == self.lastProcessedAssetId { return }
            if let cDate = asset.creationDate, cDate.timeIntervalSince(self.monitoringStartDate) < -2.0 {
                return
            }
        }

        self.lastProcessedAssetId = asset.localIdentifier
        self.isProcessingAutoTask = true

        let reqOpts = PHImageRequestOptions()
        reqOpts.isSynchronous = false
        reqOpts.deliveryMode = .highQualityFormat
        reqOpts.isNetworkAccessAllowed = true

        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: reqOpts) { [weak self] data, _, _, _ in
            guard let self = self else { return }
            guard let imgData = data, let image = UIImage(data: imgData) else {
                self.isProcessingAutoTask = false
                return
            }
            self.processBackgroundScreenshot(image)
        }
    }

    // MARK: - 剪贴板外文实时检测
    private func checkClipboardChange() {
        guard !isProcessingAutoTask else { return }
        let currentCount = UIPasteboard.general.changeCount
        guard currentCount != self.lastPasteboardCount else { return }
        self.lastPasteboardCount = currentCount

        if let copiedImage = UIPasteboard.general.image {
            self.isProcessingAutoTask = true
            self.processBackgroundScreenshot(copiedImage)
            return
        }

        if let copiedText = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
           copiedText.count >= 2, copiedText.count <= 1500 {
            self.isProcessingAutoTask = true
            self.translateTextsBaidu([copiedText]) { [weak self] translated in
                guard let self = self else { return }
                let dst = translated.first ?? copiedText
                DispatchQueue.main.async {
                    self.currentPiPImage = self.renderStatusCard(
                        badge: "📋 剪贴板实时翻译",
                        title: dst,
                        subtitle: "原文：\\(copiedText)",
                        accentColor: UIColor(red: 0.06, green: 0.72, blue: 0.50, alpha: 1.0)
                    )
                    self.enqueueCurrentPiPFrame()
                    self.isProcessingAutoTask = false
                }
            }
        }
    }

    // MARK: - 后台全自动流水线：端侧 Vision OCR -> 百度翻译 -> 1:1 原位渲染 -> 刷新 PiP 悬浮窗
    private func processBackgroundScreenshot(_ sourceImage: UIImage) {
        let normalizedImg = normalizeImageOrientation(sourceImage)
        guard let cgImage = normalizedImg.cgImage else {
            self.isProcessingAutoTask = false
            return
        }

        runVisionOcr(on: cgImage) { [weak self] rawBoxes in
            guard let self = self else { return }
            let mergedBoxes = self.mergeOcrBoxes(rawBoxes)
            if mergedBoxes.isEmpty {
                DispatchQueue.main.async {
                    self.currentPiPImage = normalizedImg
                    self.enqueueCurrentPiPFrame()
                    self.isProcessingAutoTask = false
                }
                return
            }

            let sourceTexts = mergedBoxes.map { $0.text }
            self.translateTextsBaidu(sourceTexts) { [weak self] translatedList in
                guard let self = self else { return }
                var finalBoxes: [OcrLineBox] = []
                for (idx, var box) in mergedBoxes.enumerated() {
                    box.dst = idx < translatedList.count ? translatedList[idx] : box.text
                    finalBoxes.append(box)
                }

                DispatchQueue.main.async {
                    let rendered = self.renderInPlaceImage(baseImage: normalizedImg, boxes: finalBoxes)
                    self.currentPiPImage = rendered
                    self.enqueueCurrentPiPFrame()
                    self.syncTranslatedResultToWeb(renderedImage: rendered, boxes: finalBoxes)
                    self.isProcessingAutoTask = false
                }
            }
        }
    }

    private func runVisionOcr(on cgImage: CGImage, completion: @escaping ([OcrLineBox]) -> Void) {
        let imgW = CGFloat(cgImage.width)
        let imgH = CGFloat(cgImage.height)

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest { req, _ in
                let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
                var boxes: [OcrLineBox] = []
                for obs in observations {
                    guard let top = obs.topCandidates(1).first else { continue }
                    let txt = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                    if txt.count < 2 { continue }
                    let rect = obs.boundingBox
                    let x = rect.origin.x * imgW
                    let y = (1.0 - rect.origin.y - rect.size.height) * imgH
                    let w = rect.size.width * imgW
                    let h = rect.size.height * imgH
                    boxes.append(OcrLineBox(text: txt, dst: txt, x: x, y: y, w: w, h: h))
                }
                completion(boxes)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["ja-JP", "en-US", "zh-Hans", "zh-Hant", "ko-KR", "fr-FR", "de-DE", "es-ES"]

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            try? handler.perform([request])
        }
    }

    private func mergeOcrBoxes(_ lines: [OcrLineBox]) -> [OcrLineBox] {
        guard !lines.isEmpty else { return [] }
        let sorted = lines.sorted { a, b in
            if abs(a.y - b.y) < 12 { return a.x < b.x }
            return a.y < b.y
        }
        var blocks: [OcrLineBox] = []
        var cur = sorted[0]
        for i in 1..<sorted.count {
            let nxt = sorted[i]
            let vGap = nxt.y - (cur.y + cur.h)
            let avgH = (cur.h + nxt.h) * 0.5
            let sameCol = abs(nxt.x - cur.x) < max(cur.w, nxt.w) * 0.55
            if vGap >= -avgH * 0.4 && vGap <= avgH * 0.85 && sameCol {
                let nx = min(cur.x, nxt.x)
                let ny = min(cur.y, nxt.y)
                let nw = max(cur.x + cur.w, nxt.x + nxt.w) - nx
                let nh = max(cur.y + cur.h, nxt.y + nxt.h) - ny
                cur = OcrLineBox(text: cur.text + " " + nxt.text, dst: "", x: nx, y: ny, w: nw, h: nh)
            } else {
                blocks.append(cur)
                cur = nxt
            }
        }
        blocks.append(cur)
        return blocks
    }

    // MARK: - 原生百度翻译 API 调用 (支持后台 URLSession 执行)
    private func translateTextsBaidu(_ texts: [String], completion: @escaping ([String]) -> Void) {
        guard !texts.isEmpty, !baiduAppId.isEmpty, !baiduSecretKey.isEmpty else {
            completion(texts)
            return
        }
        let cleaned = texts.map { $0.replacingOccurrences(of: "\\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines) }
        let joinedQ = cleaned.joined(separator: "\\n")
        let salt = String(Int(Date().timeIntervalSince1970 * 1000))
        let signRaw = baiduAppId + joinedQ + salt + baiduSecretKey
        let sign = md5Hex(signRaw)

        guard let url = URL(string: "https://fanyi-api.baidu.com/api/trans/vip/translate") else {
            completion(texts)
            return
        }

        var req = URLRequest(url: url, timeoutInterval: 10.0)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded; charset=utf-8", forHTTPHeaderField: "Content-Type")

        var comps = URLComponents()
        comps.queryItems = [
            URLQueryItem(name: "q", value: joinedQ),
            URLQueryItem(name: "from", value: "auto"),
            URLQueryItem(name: "to", value: targetLang),
            URLQueryItem(name: "appid", value: baiduAppId),
            URLQueryItem(name: "salt", value: salt),
            URLQueryItem(name: "sign", value: sign)
        ]
        req.httpBody = comps.percentEncodedQuery?.data(using: .utf8)

        URLSession.shared.dataTask(with: req) { data, _, err in
            guard err == nil,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let transResult = json["trans_result"] as? [[String: Any]] else {
                completion(texts)
                return
            }
            var map: [String: String] = [:]
            for item in transResult {
                if let s = item["src"] as? String, let d = item["dst"] as? String {
                    map[s.trimmingCharacters(in: .whitespacesAndNewlines)] = d
                }
            }
            let results = cleaned.enumerated().map { idx, src -> String in
                if let hit = map[src] { return hit }
                if idx < transResult.count, let d = transResult[idx]["dst"] as? String { return d }
                return src
            }
            completion(results)
        }.resume()
    }

    private func md5Hex(_ str: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(str.utf8))
        return digest.map { String(format: "%02hhx", $0) }.joined()
    }

    // MARK: - 1:1 原位覆盖渲染器（适配 iOS 画中画高清显示）
    private func renderInPlaceImage(baseImage: UIImage, boxes: [OcrLineBox]) -> UIImage {
        let size = baseImage.size
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: size, format: format)

        return renderer.image { ctx in
            baseImage.draw(in: CGRect(origin: .zero, size: size))
            let cgCtx = ctx.cgContext

            for box in boxes {
                let pad: CGFloat = 6.0
                let rect = CGRect(
                    x: max(0, box.x - pad),
                    y: max(0, box.y - pad * 0.6),
                    width: min(size.width - box.x, box.w + pad * 2),
                    height: min(size.height - box.y, box.h + pad * 1.4)
                )

                // 高对比度深色半透明底块 + 翡翠绿细边框（保证在画中画小窗缩放时依然清晰可读）
                let path = UIBezierPath(roundedRect: rect, cornerRadius: 8.0)
                UIColor(red: 0.05, green: 0.06, blue: 0.08, alpha: 0.92).setFill()
                path.fill()

                cgCtx.setStrokeColor(UIColor(red: 0.06, green: 0.72, blue: 0.50, alpha: 0.65).cgColor)
                cgCtx.setLineWidth(max(1.5, size.width * 0.002))
                cgCtx.addPath(path.cgPath)
                cgCtx.strokePath()

                // 自适应字号计算
                let minFontSize = max(16.0, size.width * 0.022)
                let maxFontSize = min(46.0, rect.height * 0.78)
                var fontSize = max(minFontSize, maxFontSize)
                let paragraph = NSMutableParagraphStyle()
                paragraph.lineBreakMode = .byWordWrapping
                paragraph.alignment = .left

                var attrs: [NSAttributedString.Key: Any] = [:]
                var textBounds = CGRect.zero
                let availW = max(24.0, rect.width - 12.0)

                while fontSize >= minFontSize {
                    let font = UIFont.systemFont(ofSize: fontSize, weight: .bold)
                    attrs = [
                        .font: font,
                        .foregroundColor: UIColor.white,
                        .paragraphStyle: paragraph
                    ]
                    textBounds = (box.dst as NSString).boundingRect(
                        with: CGSize(width: availW, height: .greatestFiniteMagnitude),
                        options: [.usesLineFragmentOrigin, .usesFontLeading],
                        attributes: attrs,
                        context: nil
                    )
                    if textBounds.height <= rect.height - 6.0 || fontSize <= minFontSize {
                        break
                    }
                    fontSize -= 2.0
                }

                // 如果多行译文高度略超原框，自动向下扩展底块以防截断
                if textBounds.height + 10.0 > rect.height {
                    let extraRect = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: textBounds.height + 10.0)
                    let extraPath = UIBezierPath(roundedRect: extraRect, cornerRadius: 8.0)
                    UIColor(red: 0.05, green: 0.06, blue: 0.08, alpha: 0.94).setFill()
                    extraPath.fill()
                }

                let drawRect = CGRect(
                    x: rect.minX + 6.0,
                    y: rect.minY + max(3.0, (rect.height - textBounds.height) * 0.5),
                    width: availW,
                    height: max(rect.height, textBounds.height + 8.0)
                )
                (box.dst as NSString).draw(in: drawRect, withAttributes: attrs)
            }
        }
    }

    private func renderStatusCard(badge: String, title: String, subtitle: String, accentColor: UIColor) -> UIImage {
        let size = CGSize(width: 720, height: 1280)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1.0
        let renderer = UIGraphicsImageRenderer(size: size, format: format)

        return renderer.image { ctx in
            let cg = ctx.cgContext
            UIColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1.0).setFill()
            cg.fill(CGRect(origin: .zero, size: size))

            let cardRect = CGRect(x: 36, y: 120, width: size.width - 72, height: size.height - 240)
            let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 28)
            UIColor(red: 0.08, green: 0.09, blue: 0.11, alpha: 1.0).setFill()
            cardPath.fill()

            cg.setStrokeColor(accentColor.withAlphaComponent(0.6).cgColor)
            cg.setLineWidth(3.0)
            cg.addPath(cardPath.cgPath)
            cg.strokePath()

            let badgeAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 24, weight: .bold),
                .foregroundColor: accentColor
            ]
            (badge as NSString).draw(in: CGRect(x: 76, y: 170, width: size.width - 152, height: 40), withAttributes: badgeAttrs)

            let titleAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 38, weight: .heavy),
                .foregroundColor: UIColor.white
            ]
            (title as NSString).draw(in: CGRect(x: 76, y: 240, width: size.width - 152, height: 360), withAttributes: titleAttrs)

            let subAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 26, weight: .medium),
                .foregroundColor: UIColor(white: 0.72, alpha: 1.0)
            ]
            (subtitle as NSString).draw(in: CGRect(x: 76, y: 620, width: size.width - 152, height: 480), withAttributes: subAttrs)
        }
    }

    // MARK: - 向 AVSampleBufferDisplayLayer 推流
    private func enqueueCurrentPiPFrame() {
        guard let layer = self.sampleLayer,
              let img = self.currentPiPImage,
              let sb = makeSampleBuffer(from: img) else {
            return
        }
        if layer.status == .failed {
            layer.flush()
        }
        layer.enqueue(sb)
    }

    private func makeSampleBuffer(from image: UIImage) -> CMSampleBuffer? {
        let width = 720
        let height = 1280
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any]
        ]
        var pixelBufferOut: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &pixelBufferOut
        )
        guard status == kCVReturnSuccess, let pixelBuffer = pixelBufferOut else { return nil }

        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue

        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else { return nil }

        context.setFillColor(red: 0.035, green: 0.035, blue: 0.043, alpha: 1.0)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        if let cgImg = image.cgImage {
            let imgW = CGFloat(cgImg.width)
            let imgH = CGFloat(cgImg.height)
            let scale = min(CGFloat(width) / max(imgW, 1), CGFloat(height) / max(imgH, 1))
            let drawW = imgW * scale
            let drawH = imgH * scale
            let drawX = (CGFloat(width) - drawW) / 2.0
            let drawY = (CGFloat(height) - drawH) / 2.0
            context.interpolationQuality = .high
            context.draw(cgImg, in: CGRect(x: drawX, y: drawY, width: drawW, height: drawH))
        }

        var formatDescOut: CMVideoFormatDescription?
        let descStatus = CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescriptionOut: &formatDescOut
        )
        guard descStatus == noErr, let formatDesc = formatDescOut else { return nil }

        let now = CMClockGetTime(CMClockGetHostTimeClock())
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 4),
            presentationTimeStamp: now,
            decodeTimeStamp: .invalid
        )

        var sampleBufferOut: CMSampleBuffer?
        let sbStatus = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: pixelBuffer,
            formatDescription: formatDesc,
            sampleTiming: &timing,
            sampleBufferOut: &sampleBufferOut
        )
        guard sbStatus == noErr, let sampleBuffer = sampleBufferOut else { return nil }

        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true) as? [NSMutableDictionary],
           let first = attachments.first {
            first[kCMSampleBufferAttachmentKey_DisplayImmediately] = kCFBooleanTrue
        }
        return sampleBuffer
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

    // MARK: - 工具方法与前端通知
    private func decodeBase64Image(_ base64Str: String) -> UIImage? {
        let cleanB64: String
        if let commaRange = base64Str.range(of: ",") {
            cleanB64 = String(base64Str[commaRange.upperBound...])
        } else {
            cleanB64 = base64Str
        }
        guard let imgData = Data(base64Encoded: cleanB64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: imgData)
    }

    private func normalizeImageOrientation(_ image: UIImage) -> UIImage {
        if image.imageOrientation == .up { return image }
        UIGraphicsBeginImageContextWithOptions(image.size, false, image.scale)
        image.draw(in: CGRect(origin: .zero, size: image.size))
        let normalized = UIGraphicsGetImageFromCurrentImageContext() ?? image
        UIGraphicsEndImageContext()
        return normalized
    }

    private func sendOcrResult(to webView: WKWebView, callbackId: String, lines: [[String: Any]]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: lines, options: []),
              let jsonStr = String(data: jsonData, encoding: .utf8) else {
            return
        }
        DispatchQueue.main.async {
            let js = "window.__onNativeOcrResult && window.__onNativeOcrResult('\\(callbackId)', \\(jsonStr));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func notifyWebPiPState(active: Bool, message: String) {
        for webView in attachedWebViews.allObjects {
            let safeMsg = message.replacingOccurrences(of: "'", with: "\\\\'")
            let js = "window.__onNativePiPState && window.__onNativePiPState(\\(active ? "true" : "false"), '\\(safeMsg)');"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func syncTranslatedResultToWeb(renderedImage: UIImage, boxes: [OcrLineBox]) {
        guard let jpegData = renderedImage.jpegData(compressionQuality: 0.82) else { return }
        let b64 = "data:image/jpeg;base64," + jpegData.base64EncodedString()
        let blockDicts = boxes.map { b -> [String: Any] in
            return ["src": b.text, "dst": b.dst, "x": b.x, "y": b.y, "w": b.w, "h": b.h]
        }
        guard let jsonData = try? JSONSerialization.data(withJSONObject: blockDicts, options: []),
              let blocksJson = String(data: jsonData, encoding: .utf8) else {
            return
        }
        for webView in attachedWebViews.allObjects {
            let js = "window.__onNativeLiveTranslated && window.__onNativeLiveTranslated(\\"\\(b64)\\", \\(blocksJson));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    private func bindVisionBridge() {
        if let vc = self.window?.rootViewController as? CAPBridgeViewController,
           let wv = vc.webView {
            VisionOcrHandler.shared.attachIfNeeded(to: wv)
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.bindVisionBridge()
        }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        bindVisionBridge()
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}
`;

fs.writeFileSync(appDelegatePath, swiftCode, "utf8");
console.log("[OK] 已注入 iOS Apple Vision OCR + 全局画中画 (PiP) 实时悬浮翻译引擎至 AppDelegate.swift");
