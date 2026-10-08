import Foundation
import Security
import CryptoKit

struct Pairing: Equatable, Codable, Identifiable {
    var id: String { pin }
    var isDevice: Bool { token.isEmpty }
    init(host: String, port: Int, pin: String, name: String) throws {
        guard (1...65535).contains(port), host.range(of: "^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", options: .regularExpression) != nil, host.split(separator: ".").allSatisfy({ Int($0).map { (0...255).contains($0) } ?? false }), pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw RelayError.message("Invalid nearby computer.") }
        self.host = host; self.port = port; self.pin = pin; self.name = String(name.prefix(80)); self.token = ""
    }
    let host: String
    let port: Int
    let token: String
    let pin: String
    let name: String
    init(_ text: String) throws {
        if text.hasPrefix("{") {
            guard text.utf8.count <= 4096 else { throw RelayError.message("Invalid saved route.") }
            let saved = try JSONDecoder().decode(Pairing.self, from: Data(text.utf8))
            guard saved.token.isEmpty else { throw RelayError.message("Invalid saved route.") }
            self = try Pairing(host: saved.host, port: saved.port, pin: saved.pin, name: saved.name); return
        }
        guard text.utf8.count <= 4096, let u = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme == "wavbounce", u.host == "join" else { throw RelayError.message("Paste the pairing link from the sending computer.") }
        let pairs = u.queryItems ?? []
        func value(_ key: String) -> String { pairs.first(where: { $0.name == key })?.value ?? "" }
        let host = value("host"), token = value("token"), pin = value("pin")
        guard value("v") == "1", let port = Int(value("port")), (1...65535).contains(port),
              host.range(of: "^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$", options: .regularExpression) != nil,
              token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw RelayError.message("That pairing link is incomplete or unsupported. Copy it again.") }
        self.host = host; self.port = port; self.token = token; self.pin = pin
        name = String(value("name").prefix(80)).isEmpty ? "Computer" : String(value("name").prefix(80))
    }
    var endpoint: URL { var u = URLComponents(); u.scheme = "wss"; u.host = host; u.port = port; u.path = "/signal"; return u.url! }
}
enum RelayError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
enum RouteStore {
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.huntercreative.wavbounce.route", kSecAttrAccount as String: "last-route"] }
    static func read() -> String? {
        var q = query; q[kSecReturnData as String] = true; var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func save(_ text: String) throws {
        let data = Data(text.utf8)
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw RelayError.message("Connected, but the route could not be saved securely.") }
        var q = query; q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw RelayError.message("Connected, but the route could not be saved securely.") }
    }
    static func delete() { SecItemDelete(query as CFDictionary) }
}

@MainActor enum DeviceIdentity {
    private static var cached: Curve25519.Signing.PrivateKey?
    static func key() throws -> Curve25519.Signing.PrivateKey {
        if let cached { return cached }
        #if DEBUG && targetEnvironment(macCatalyst)
        if ProcessInfo.processInfo.environment["RELAY_NATIVE_TEST_RESULT"] != nil {
            let key = Curve25519.Signing.PrivateKey(); cached = key; return key
        }
        #endif
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.huntercreative.wavbounce.device", kSecAttrAccount as String: "ed25519"]
        var read = query; read[kSecReturnData as String] = true; var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data { let key = try Curve25519.Signing.PrivateKey(rawRepresentation: data); cached = key; return key }
        guard status == errSecItemNotFound else { throw RelayError.message("Unlock this device to access its saved identity.") }
        let key = Curve25519.Signing.PrivateKey(); var save = query
        save[kSecValueData as String] = key.rawRepresentation; save[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(save as CFDictionary, nil) == errSecSuccess else { throw RelayError.message("This device identity could not be saved securely.") }
        cached = key; return key
    }
    static func base64url(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func proof(pin: String, nonce: String, name: String) throws -> (signature: String, code: String) {
        guard nonce.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw RelayError.message("Invalid pairing challenge.") }
        let key = try key(), publicKey = base64url(key.publicKey.rawRepresentation)
        let data = try JSONSerialization.data(withJSONObject: ["WavBounce device pairing 1", pin, nonce, publicKey, name], options: [.withoutEscapingSlashes])
        let digest = Array(SHA256.hash(data: data)); let value = digest.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        return (base64url(try key.signature(for: data)), String(format: "%06u", value % 1_000_000))
    }
}
