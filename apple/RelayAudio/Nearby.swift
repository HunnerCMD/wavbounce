import Foundation
import Darwin

// Bonjour advertises public endpoints only. Audio still requires certificate pinning
// and a matching code approved by the source, never trust based on a display name.
@MainActor final class Nearby: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    var changed: ([Pairing]) -> Void = { _ in }
    var notice: (String) -> Void = { _ in }
    private var browser: NetServiceBrowser?
    private var services: [NetService] = []
    private var routes: [String: Pairing] = [:]
    func start() {
        stop(); let browser = NetServiceBrowser(); self.browser = browser
        browser.delegate = self; browser.searchForServices(ofType: "_wavbounce._tcp.", inDomain: "local.")
        notice("Looking for sharing computers on your local network…")
    }
    func stop() {
        browser?.stop(); browser?.delegate = nil; browser = nil
        for service in services { service.stop(); service.delegate = nil }
        services.removeAll(); routes.removeAll(); changed([])
    }
    private func identifier(_ service: NetService) -> String { service.domain + service.type + service.name }
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard self.browser === browser, services.count < 64 else { return }
        services.append(service); service.delegate = self; service.resolve(withTimeout: 8)
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
        guard self.browser === browser else { return }
        let id = identifier(service)
        for existing in services where identifier(existing) == id { existing.stop(); existing.delegate = nil }
        services.removeAll { identifier($0) == id }; routes.removeValue(forKey: id); publish()
    }
    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard self.browser === browser else { return }
        notice("Nearby is unavailable. Allow WavBounce in Settings → Privacy & Security → Local Network, then Refresh.")
    }
    func netServiceDidResolveAddress(_ service: NetService) {
        guard services.contains(where: { $0 === service }), let data = service.txtRecordData(), data.count <= 2048 else { return }
        let txt = NetService.dictionary(fromTXTRecord: data)
        func text(_ key: String) -> String { String(data: txt[key] ?? Data(), encoding: .utf8) ?? "" }
        guard text("v") == "1", text("pairing") == "confirm-v1" else { return }
        for address in service.addresses ?? [] {
            let host: String? = address.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr_in>.size else { return nil }
                let socket = base.assumingMemoryBound(to: sockaddr.self)
                guard socket.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                guard getnameinfo(socket, socklen_t(bytes.count), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
                return String(cString: buffer)
            }
            if let host, let route = try? Pairing(host: host, port: service.port, pin: text("pin"), name: text("name")) {
                routes[identifier(service)] = route; publish(); return
            }
        }
    }
    private func publish() {
        var unique: [String: Pairing] = [:]
        for route in routes.values { unique[route.pin] = route }
        changed(unique.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending })
        notice(unique.isEmpty ? "Start sharing on your computer, then Refresh. Both devices must be on the same network." : "Choose a computer and compare the code on both devices.")
    }
}
