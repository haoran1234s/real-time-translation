/**
 * 向 Capacitor 生成的 iOS 工程注入 Apple Vision 原生硬件级 OCR 桥接器 (VNRecognizeTextRequest)
 * 使打包出的 .ipa 在 iPhone 上无需连接电脑服务器即可秒级完成多语种屏幕文字与坐标框识别
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
import Capacitor

/// iOS 原生 Apple Vision (VNRecognizeTextRequest) 极速端侧 OCR 处理器
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
              let callbackId = body["callbackId"] as? String,
              let base64Str = body["imageBase64"] as? String,
              let webView = message.webView else {
            return
        }

        let cleanB64: String
        if let commaRange = base64Str.range(of: ",") {
            cleanB64 = String(base64Str[commaRange.upperBound...])
        } else {
            cleanB64 = base64Str
        }

        guard let imgData = Data(base64Encoded: cleanB64, options: .ignoreUnknownCharacters),
              let uiImage = UIImage(data: imgData),
              let cgImage = uiImage.cgImage else {
            sendResult(to: webView, callbackId: callbackId, lines: [])
            return
        }

        let imgW = Double(cgImage.width)
        let imgH = Double(cgImage.height)

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest { [weak self] req, _ in
                let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
                var lines: [[String: Any]] = []
                for obs in observations {
                    guard let top = obs.topCandidates(1).first else { continue }
                    let box = obs.boundingBox
                    let x = box.origin.x * imgW
                    let y = (1.0 - box.origin.y - box.size.height) * imgH
                    let w = box.size.width * imgW
                    let h = box.size.height * imgH
                    lines.append([
                        "text": top.string,
                        "x": (x * 10).rounded() / 10,
                        "y": (y * 10).rounded() / 10,
                        "w": (w * 10).rounded() / 10,
                        "h": (h * 10).rounded() / 10
                    ])
                }
                self?.sendResult(to: webView, callbackId: callbackId, lines: lines)
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["ja-JP", "en-US", "zh-Hans", "zh-Hant", "ko-KR", "fr-FR", "de-DE", "es-ES"]

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            try? handler.perform([request])
        }
    }

    private func sendResult(to webView: WKWebView, callbackId: String, lines: [[String: Any]]) {
        guard let jsonData = try? JSONSerialization.data(withJSONObject: lines, options: []),
              let jsonStr = String(data: jsonData, encoding: .utf8) else {
            return
        }
        DispatchQueue.main.async {
            let js = "window.__onNativeOcrResult && window.__onNativeOcrResult('\\(callbackId)', \\(jsonStr));"
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
console.log("[OK] 已注入 iOS Apple Vision 原生硬件级 OCR 桥接器至 AppDelegate.swift");
