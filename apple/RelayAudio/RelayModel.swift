import Foundation
import AVFoundation
import CryptoKit
import Combine
@preconcurrency import WebRTC

final class PinnedSessionDelegate: NSObject, URLSessionDelegate {
    let pairing: Pairing
    init(_ pairing: Pairing) { self.pairing = pairing }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == pairing.host,
              let trust = challenge.protectionSpace.serverTrust,
              let cert = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let digest = SHA256.hash(data: SecCertificateCopyData(cert) as Data).map { String(format: "%02x", $0) }.joined()
        guard digest == pairing.pin else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        // A session link supplies the pin out of band. Nearby additionally requires
        // the matching source approval code before media is established.
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

@MainActor final class RelayModel: NSObject, ObservableObject {
    @Published var link = RouteStore.read() ?? ""
    @Published var remember = true
    @Published var nearby: [Pairing] = []
    @Published var discoveryStatus = ""
    @Published var pairingCode: String?
    private let discovery = Nearby()
    private var expectedCode: String?
    private var welcomed = false
    private let deviceName = "iPad / iPhone"
    @Published var status = "Ready when you are" { didSet { debugStatus() } }
    @Published var sourceName = "Your computer"
    @Published var connected = false
    @Published var active = false
    @Published var needsResume = false
    @Published var error: String?
    @Published var volume: Double = 0.35 { didSet { track?.source.volume = volume } }
    @Published var bitrate = "—"
    @Published var buffer = "—"
    @Published var jitter = "—"
    @Published var lost = "—"
    @Published var level: Double = 0
    private let factory = RTCPeerConnectionFactory()
    private var pc: RTCPeerConnection?
    private var track: RTCAudioTrack?
    private var pairing: Pairing?
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var statsTask: Task<Void, Never>?
    private var iceTask: Task<Void, Never>?
    private var generation = 0
    private var retries = 0
    private var offerSent = false
    private var previousBytes: Double = 0
    private var previousEmitted: Double = 0
    private var previousDelay: Double = 0
    private var previousTimestamp: Double = 0
    private var observations: [NSObjectProtocol] = []

    private func debugStatus() {
        #if DEBUG && targetEnvironment(macCatalyst)
        if ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] != nil {
            NSLog("Native integration state: %@", status)
        }
        #endif
    }

    override init() {
        super.init()
        discovery.changed = { [weak self] routes in
            guard let self else { return }; self.nearby = routes
            #if DEBUG && targetEnvironment(macCatalyst)
            if ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] != nil, let name = ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_SOURCE"], !self.active, let target = routes.first(where: { $0.name == name }) { self.connectNearby(target) }
            #endif
        }
        discovery.notice = { [weak self] message in self?.discoveryStatus = message }
        let playback = RTCAudioSessionConfiguration.webRTC()
        playback.category = AVAudioSession.Category.playback.rawValue
        playback.mode = AVAudioSession.Mode.default.rawValue
        playback.categoryOptions = [.mixWithOthers]
        playback.sampleRate = 48000
        playback.outputNumberOfChannels = 2
        RTCAudioSessionConfiguration.setWebRTC(playback)
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        observations.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            Task { @MainActor in if type == .began { self?.pauseForOutput("Playback interrupted. Tap Resume when ready.") } }
        })
        observations.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            Task { @MainActor in if reason == .oldDeviceUnavailable { self?.pauseForOutput("Audio output disconnected. Choose your output, then Resume.") } }
        })
        #if DEBUG && targetEnvironment(macCatalyst)
        if ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] != nil { remember = false; volume = 0; link = "" }
        if let testLink = ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_LINK"] {
            link = testLink; remember = false; volume = 0
            Task { self.connect() }
        }
        #endif
    }
    func refreshNearby() { discovery.start() }
    func pauseDiscovery() { discovery.stop() }
    func connectNearby(_ target: Pairing) {
        do { link = String(decoding: try JSONEncoder().encode(target), as: UTF8.self); connect() }
        catch { self.error = error.localizedDescription }
    }
    func connect() {
        do {
            let target = try Pairing(link)
            stop(); pairing = target; active = true; sourceName = target.name; retries = 0
            establish(generation)
        } catch { self.error = error.localizedDescription }
    }
    func stop() {
        generation += 1; pairingCode = nil; expectedCode = nil; active = false; connected = false; needsResume = false; pairing = nil
        retryTask?.cancel(); reader?.cancel(); statsTask?.cancel(); iceTask?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        session?.invalidateAndCancel(); session = nil
        pc?.close(); pc = nil; track = nil
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        let audio = RTCAudioSession.sharedInstance(); audio.lockForConfiguration()
        try? audio.setActive(false); audio.unlockForConfiguration()
        status = "Ready when you are"; resetStats()
    }
    func forget() { RouteStore.delete(); link = ""; remember = false }
    func configurePlayback() throws {
        let audio = RTCAudioSession.sharedInstance(); audio.lockForConfiguration(); defer { audio.unlockForConfiguration() }
        try audio.setCategory(.playback, with: [.mixWithOthers])
        try audio.setMode(.default)
        try audio.setActive(true)
        audio.isAudioEnabled = true
    }
    func pauseForOutput(_ message: String) {
        guard active else { return }
        RTCAudioSession.sharedInstance().isAudioEnabled = false; needsResume = true; status = message
    }
    func resume() { do { try configurePlayback(); needsResume = false; status = connected ? "Playing your computer audio" : "Connecting…" } catch { self.error = error.localizedDescription } }
    private func establish(_ gen: Int) {
        guard gen == generation, active, let pairing else { return }
        if pairing.isDevice, let fresh = nearby.first(where: { $0.pin == pairing.pin }) { self.pairing = fresh }
        guard let pairing = self.pairing else { return }
        pairingCode = nil; expectedCode = nil; welcomed = false
        pc?.close(); pc = nil; track = nil; connected = false; resetStats(); offerSent = false
        statsTask?.cancel(); iceTask?.cancel(); session?.invalidateAndCancel()
        status = retries == 0 ? "Connecting securely…" : "Waiting for the sending computer…"
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: PinnedSessionDelegate(pairing), delegateQueue: nil)
        let ws = session!.webSocketTask(with: pairing.endpoint); ws.maximumMessageSize = 128 * 1024; socket = ws; ws.resume()
        reader = Task { [weak self] in
            do {
                guard let self else { return }
                if pairing.isDevice {
                    let key = try DeviceIdentity.key()
                    try await self.send(["type": "hello", "v": 1, "method": "device", "key": DeviceIdentity.base64url(key.publicKey.rawRepresentation), "name": self.deviceName])
                } else { try await self.send(["type": "hello", "v": 1, "token": pairing.token, "name": self.deviceName]) }
                while !Task.isCancelled && gen == self.generation && self.active {
                    let data = try await ws.receive()
                    let bytes: Data
                    switch data { case .string(let text): bytes = Data(text.utf8); case .data(let value): bytes = value; @unknown default: throw RelayError.message("Unsupported response.") }
                    guard bytes.count <= 128 * 1024, let message = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw RelayError.message("Invalid audio response.") }
                    try await self.handle(message, gen: gen)
                }
            } catch {
                guard let self, gen == self.generation, self.active, !Task.isCancelled else { return }
                #if DEBUG && targetEnvironment(macCatalyst)
                if ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] != nil { NSLog("Native integration error: %@", error.localizedDescription) }
                #endif
                if ws.closeCode == .policyViolation { let reason = ws.closeReason.flatMap { String(data: $0, encoding: .utf8) }; self.stop(); self.status = reason.map { String($0.prefix(200)) } ?? "Connection ended by the source. Choose it in Nearby to connect again."; return }
                self.scheduleRetry(gen)
            }
        }
    }
    private func send(_ message: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: message)
        guard let socket else { throw RelayError.message("Connection stopped.") }
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
    private func handle(_ m: [String: Any], gen: Int) async throws {
        guard gen == generation else { return }
        if m["type"] as? String == "challenge", let nonce = m["nonce"] as? String, let pairing, pairing.isDevice, expectedCode == nil, !welcomed {
            let proof = try DeviceIdentity.proof(pin: pairing.pin, nonce: nonce, name: deviceName); expectedCode = proof.code
            try await send(["type": "proof", "signature": proof.signature]); return
        }
        if m["type"] as? String == "pairing", let code = m["code"] as? String, code == expectedCode, !welcomed {
            pairingCode = code; status = "Compare this code on the sending computer, then choose Allow & remember."
            #if DEBUG && targetEnvironment(macCatalyst)
            if let output = ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] { try? Data(code.utf8).write(to: URL(fileURLWithPath: output + ".code"), options: .atomic) }
            #endif
            return
        }
        if m["type"] as? String == "welcome", m["v"] as? Int == 1, !welcomed {
            guard pairing?.isDevice != true || expectedCode != nil else { throw RelayError.message("Missing device verification.") }
            welcomed = true; pairingCode = nil
            if remember, let pairing { if pairing.isDevice, let data = try? JSONEncoder().encode(pairing) { link = String(decoding: data, as: UTF8.self) }; do { try RouteStore.save(link) } catch { self.error = error.localizedDescription } }
            if !needsResume { try configurePlayback() }
            let config = RTCConfiguration(); config.sdpSemantics = .unifiedPlan; config.iceServers = []; config.bundlePolicy = .maxBundle
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else { throw RelayError.message("Audio engine could not start.") }
            pc = peer
            let transceiver = RTCRtpTransceiverInit(); transceiver.direction = .recvOnly
            peer.addTransceiver(of: .audio, init: transceiver)
            let offer = try await withCheckedThrowingContinuation { (c: CheckedContinuation<RTCSessionDescription, Error>) in peer.offer(for: constraints) { d, e in if let e { c.resume(throwing: e) } else if let d { c.resume(returning: d) } else { c.resume(throwing: RelayError.message("No audio offer.")) } } }
            guard gen == generation, pc === peer else { return }
            let d = RTCSessionDescription(type: .offer, sdp: Self.stereo(offer.sdp))
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setLocalDescription(d) { e in if let e { c.resume(throwing: e) } else { c.resume() } } }
            if peer.iceGatheringState == .complete { sendOffer(peer, gen: gen) }
            iceTask = Task { [weak self, weak peer] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, let self, let peer, self.generation == gen, self.pc === peer, !self.offerSent else { return }
                self.scheduleRetry(gen)
            }
        } else if m["type"] as? String == "answer", let d = m["description"] as? [String: String], d["type"] == "answer", let sdp = d["sdp"], Self.audioOnly(sdp), let peer = pc {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { e in if let e { c.resume(throwing: e) } else { c.resume() } } }
        } else { throw RelayError.message("The sender returned an unsupported audio message.") }
    }
    static func audioOnly(_ sdp: String) -> Bool { let media = sdp.components(separatedBy: .newlines).filter { $0.hasPrefix("m=") }; return sdp.utf8.count < 100000 && media.count == 1 && media[0].hasPrefix("m=audio ") && sdp.contains("a=fingerprint:sha-256 ") }
    static func stereo(_ sdp: String) -> String {
        let lines = sdp.components(separatedBy: "\r\n")
        let opus = lines.first { $0.hasPrefix("a=rtpmap:") && $0.contains(" opus/48000") }?.split(separator: " ").first?.replacingOccurrences(of: "a=rtpmap:", with: "")
        guard let opus else { return sdp }
        return lines.map { $0.hasPrefix("a=fmtp:\(opus) ") ? $0 + ";stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0" : $0 }.joined(separator: "\r\n")
    }
    private func sendOffer(_ peer: RTCPeerConnection, gen: Int) {
        guard gen == generation, pc === peer, !offerSent, let d = peer.localDescription else { return }
        offerSent = true; iceTask?.cancel()
        Task { [weak self] in do { try await self?.send(["type": "offer", "description": ["type": "offer", "sdp": d.sdp]]) } catch { self?.scheduleRetry(gen) } }
    }
    private func scheduleRetry(_ gen: Int) {
        guard gen == generation, active else { return }
        generation += 1
        let nextGeneration = generation
        reader?.cancel(); statsTask?.cancel(); iceTask?.cancel(); retryTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil); pc?.close(); pc = nil; track = nil
        connected = false; status = "Connection interrupted. Reconnecting…"
        let delay = min(15.0, 0.75 * pow(2.0, Double(min(retries, 5)))); retries += 1
        retryTask = Task { [weak self] in try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)); guard !Task.isCancelled else { return }; self?.establish(nextGeneration) }
    }
    private func resetStats() { bitrate = "—"; buffer = "—"; jitter = "—"; lost = "—"; level = 0; previousBytes = 0; previousEmitted = 0; previousDelay = 0; previousTimestamp = 0 }
    private func startStats(_ peer: RTCPeerConnection) {
        statsTask?.cancel()
        statsTask = Task { [weak self, weak peer] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self, let peer, self.pc === peer else { return }
                peer.statistics { [weak self] report in Task { @MainActor in guard let self, self.pc === peer else { return }; self.consume(report) } }
            }
        }
    }
    private func consume(_ report: RTCStatisticsReport) {
        for s in report.statistics.values where s.type == "inbound-rtp" && (s.values["kind"] as? String == "audio" || s.values["mediaType"] as? String == "audio") {
            func n(_ key: String) -> Double { (s.values[key] as? NSNumber)?.doubleValue ?? 0 }
            let bytes = n("bytesReceived"), emitted = n("jitterBufferEmittedCount"), delay = n("jitterBufferDelay"), time = s.timestamp_us / 1_000_000
            if previousTimestamp > 0, time > previousTimestamp { bitrate = String(format: "%.0f kb/s", 8 * (bytes - previousBytes) / (time - previousTimestamp) / 1000) }
            if emitted > previousEmitted { buffer = String(format: "%.1f ms", 1000 * (delay - previousDelay) / (emitted - previousEmitted)) }
            jitter = String(format: "%.1f ms", n("jitter") * 1000); lost = String(format: "%.0f", n("packetsLost")); level = n("audioLevel")
            previousBytes = bytes; previousEmitted = emitted; previousDelay = delay; previousTimestamp = time
            if connected && !needsResume { status = level > 0.0001 ? "Playing your computer audio" : "Connected · source is quiet" }
            #if DEBUG && targetEnvironment(macCatalyst)
            if let output = ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"], bytes > 10000, emitted > 0 {
                let result: [String: Any] = ["timestamp": ISO8601DateFormatter().string(from: Date()), "receiver": "native Apple WebRTC via Mac Catalyst", "receivedBytes": bytes, "packetsReceived": n("packetsReceived"), "samplesEmitted": emitted, "audioEnergy": n("totalAudioEnergy"), "level": level, "outputVolume": volume, "connected": connected, "physicalIPadTested": false]
                if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: URL(fileURLWithPath: output), options: .atomic) }
            }
            #endif
        }
    }
}

extension RelayModel: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) { if newState == .complete { Task { @MainActor in self.sendOffer(peerConnection, gen: self.generation) } } }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        Task { @MainActor in guard self.pc === peerConnection else { return }; self.track = rtpReceiver.track as? RTCAudioTrack; self.track?.source.volume = self.volume }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor in
            guard self.pc === peerConnection else { return }
            if newState == .connected { self.retries = 0; self.connected = true; self.status = self.needsResume ? "Tap Resume to continue playback" : "Playing your computer audio"; self.startStats(peerConnection) }
            if newState == .failed { self.scheduleRetry(self.generation) }
            if newState == .disconnected {
                let gen = self.generation
                Task { try? await Task.sleep(nanoseconds: 5_000_000_000); guard !Task.isCancelled, self.pc === peerConnection, peerConnection.connectionState == .disconnected else { return }; self.scheduleRetry(gen) }
            }
        }
    }
}
