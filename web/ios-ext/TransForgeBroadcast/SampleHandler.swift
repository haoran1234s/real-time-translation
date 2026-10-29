//
//  SampleHandler.swift
//  TransForgeBroadcast
//
//  ReplayKit 录屏广播扩展：只负责「取样 → 变化检测 → 压缩 → 通过本机回环 TCP 发给主 App」。
//  OCR 与翻译都在主 App 中完成，避免扩展超过约 50MB 的内存上限。
//

import ReplayKit
import CoreImage
import ImageIO
import Network
import UIKit

/// 录屏广播扩展入口
final class SampleHandler: RPBroadcastSampleHandler {

    // MARK: - 常量

    /// 主 App 监听的本机回环端口（必须与主 App 保持一致）
    private let hostPort: NWEndpoint.Port = 47321
    /// 取样间隔（秒）：屏幕帧 30/60fps，绝大部分直接丢弃
    private let sampleInterval: CFTimeInterval = 0.4
    /// 兜底重发间隔（秒）：防止漏掉细微变化
    private let heartbeatInterval: CFTimeInterval = 10.0
    /// 变化检测缩略图宽度
    private let thumbWidth: CGFloat = 144
    /// 单个像素灰度差超过该值视为“变化像素”
    private let pixelDiffThreshold: Int = 22
    /// 与上次已发送画面相比，变化像素数量 ≥ 该值视为“内容已变化”
    private let changedPixelCount: Int = 40
    /// 与上一次取样相比，变化像素数量 < 该值视为“画面已停稳”
    private let stablePixelCount: Int = 15
    /// 发送给主 App 的图片长边上限
    private let maxSendSide: CGFloat = 1800
    /// 未连上主 App 时，超过该秒数自动结束广播
    private let connectTimeout: CFTimeInterval = 25.0

    // MARK: - 状态

    /// 共享 CIContext（复用以降低内存抖动）
    private let ciContext = CIContext(options: [.cacheIntermediates: false, .useSoftwareRenderer: false])
    /// 网络与发送队列
    private let netQueue = DispatchQueue(label: "transforge.broadcast.net")
    private var connection: NWConnection?
    private var isConnected = false
    private var isSending = false
    private var everConnected = false
    private var disconnectedSince: CFTimeInterval = CACurrentMediaTime()
    private var isFinishing = false

    /// 取样与变化检测状态
    private var lastSampleTime: CFTimeInterval = 0
    private var lastSentTime: CFTimeInterval = 0
    private var prevThumb: [UInt8]?
    private var sentThumb: [UInt8]?
    private var forceSendNext = true

    // MARK: - 广播生命周期

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        disconnectedSince = CACurrentMediaTime()
        connect()
    }

    override func broadcastPaused() {}

    override func broadcastResumed() {
        forceSendNext = true
    }

    override func broadcastFinished() {
        netQueue.sync {
            isFinishing = true
            connection?.cancel()
            connection = nil
        }
    }

    // MARK: - 帧处理

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }

        let now = CACurrentMediaTime()
        guard now - lastSampleTime >= sampleInterval else { return }
        lastSampleTime = now

        checkConnectionTimeout(now: now)

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let orientation = readOrientation(from: sampleBuffer)

        autoreleasepool {
            let base = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
            guard let thumb = makeThumbnail(base) else { return }

            // 与上一次取样比较 → 是否停稳
            let stable: Bool
            if let prev = prevThumb, prev.count == thumb.count {
                stable = countChangedPixels(prev, thumb) < stablePixelCount
            } else {
                stable = false
            }
            prevThumb = thumb

            // 与上次已发送画面比较 → 是否有新内容
            let changed: Bool
            if let sent = sentThumb, sent.count == thumb.count {
                changed = countChangedPixels(sent, thumb) >= changedPixelCount
            } else {
                changed = true
            }

            let heartbeatDue = now - lastSentTime >= heartbeatInterval
            let shouldSend = (stable && (changed || forceSendNext)) || (heartbeatDue && stable)
            guard shouldSend else { return }

            let canSend = netQueue.sync { isConnected && !isSending }
            guard canSend else { return }

            guard let jpeg = encodeJPEG(base) else { return }
            sentThumb = thumb
            lastSentTime = now
            forceSendNext = false
            send(jpeg)
        }
    }

    // MARK: - 图像工具

    /// 读取 ReplayKit 提供的画面方向（横屏游戏时为横向）
    private func readOrientation(from sampleBuffer: CMSampleBuffer) -> CGImagePropertyOrientation {
        if let value = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let ori = CGImagePropertyOrientation(rawValue: value.uint32Value) {
            return ori
        }
        return .up
    }

    /// 生成灰度缩略图（用于变化检测）
    private func makeThumbnail(_ image: CIImage) -> [UInt8]? {
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return nil }
        let scale = thumbWidth / extent.width
        let scaled = image
            .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let w = Int(thumbWidth)
        let h = max(1, Int((extent.height * scale).rounded(.down)))
        var bytes = [UInt8](repeating: 0, count: w * h)
        bytes.withUnsafeMutableBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            ciContext.render(
                scaled,
                toBitmap: base,
                rowBytes: w,
                bounds: CGRect(x: 0, y: 0, width: w, height: h),
                format: .L8,
                colorSpace: nil
            )
        }
        return bytes
    }

    /// 统计两张缩略图之间的变化像素数量
    private func countChangedPixels(_ a: [UInt8], _ b: [UInt8]) -> Int {
        var count = 0
        for i in 0..<min(a.count, b.count) {
            if abs(Int(a[i]) - Int(b[i])) > pixelDiffThreshold {
                count += 1
            }
        }
        return count
    }

    /// 缩放并压缩为 JPEG
    private func encodeJPEG(_ image: CIImage) -> Data? {
        let extent = image.extent
        let longSide = max(extent.width, extent.height)
        guard longSide > 0 else { return nil }
        let scale = min(1.0, maxSendSide / longSide)
        let scaled = image
            .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let options: [CIImageRepresentationOption: Any] = [
            CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7
        ]
        return ciContext.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: options)
    }

    // MARK: - 网络（本机回环 TCP）

    /// 连接主 App 的本机回环监听端口
    private func connect() {
        netQueue.async { [weak self] in
            guard let self = self, !self.isFinishing else { return }
            self.connection?.cancel()

            let conn = NWConnection(host: "127.0.0.1", port: self.hostPort, using: .tcp)
            conn.stateUpdateHandler = { [weak self, weak conn] state in
                guard let conn = conn else { return }
                self?.handleState(state, for: conn)
            }
            self.connection = conn
            conn.start(queue: self.netQueue)
        }
    }

    /// 处理连接状态变化（在 netQueue 上回调）
    private func handleState(_ state: NWConnection.State, for conn: NWConnection) {
        guard conn === connection else { return }
        switch state {
        case .ready:
            isConnected = true
            everConnected = true
            isSending = false
            forceSendNext = true
            receiveControl(on: conn)
        case .failed, .cancelled:
            markDisconnectedAndRetry()
        case .waiting:
            markDisconnectedAndRetry()
        default:
            break
        }
    }

    /// 标记断开并在 1 秒后重连
    private func markDisconnectedAndRetry() {
        if isConnected {
            disconnectedSince = CACurrentMediaTime()
        }
        isConnected = false
        isSending = false
        connection?.cancel()
        connection = nil
        guard !isFinishing else { return }
        netQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self = self, !self.isFinishing, self.connection == nil else { return }
            self.connect()
        }
    }

    /// 接收主 App 下发的控制指令（目前只有 STOP）
    private func receiveControl(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, let text = String(data: data, encoding: .utf8), text.contains("STOP") {
                self.finish(message: "已在 TransForge 中关闭实时翻译")
                return
            }
            if isComplete || error != nil {
                return
            }
            self.receiveControl(on: conn)
        }
    }

    /// 发送一帧：4 字节大端长度 + JPEG 数据
    private func send(_ jpeg: Data) {
        netQueue.async { [weak self] in
            guard let self = self, let conn = self.connection, self.isConnected, !self.isSending else { return }
            self.isSending = true
            var length = UInt32(jpeg.count).bigEndian
            var packet = Data(bytes: &length, count: 4)
            packet.append(jpeg)
            conn.send(content: packet, completion: .contentProcessed { [weak self] error in
                guard let self = self else { return }
                self.netQueue.async {
                    self.isSending = false
                    if error != nil {
                        self.markDisconnectedAndRetry()
                    }
                }
            })
        }
    }

    /// 长时间连不上主 App 时自动结束广播，避免白白耗电
    private func checkConnectionTimeout(now: CFTimeInterval) {
        let (connected, since, ever) = netQueue.sync { (isConnected, disconnectedSince, everConnected) }
        guard !connected, now - since > connectTimeout else { return }
        if ever {
            finish(message: "TransForge 已退出或被系统挂起，实时翻译已停止")
        } else {
            finish(message: "请先打开 TransForge 并点击「开启实时翻译」")
        }
    }

    /// 结束广播并给出原因（统一切到 netQueue 异步执行，避免在 netQueue 回调中同步等待自身造成死锁）
    private func finish(message: String) {
        netQueue.async { [weak self] in
            guard let self = self, !self.isFinishing else { return }
            self.isFinishing = true
            self.connection?.cancel()
            self.connection = nil
            let error = NSError(domain: "TransForgeBroadcast", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
            self.finishBroadcastWithError(error)
        }
    }
}
