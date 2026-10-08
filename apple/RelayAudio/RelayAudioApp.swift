import SwiftUI
import AVKit

@main struct RelayAudioApp: App {
    @StateObject private var model = RelayModel()
    var body: some Scene {
        WindowGroup { RelayView(model: model).onOpenURL { url in model.link = url.absoluteString } }
    }
}
struct OutputPicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView { let view = AVRoutePickerView(); view.tintColor = UIColor(Color.relayAccent); view.activeTintColor = .white; return view }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
extension Color {
    static let relayBackground = Color.black
    static let relayPanel = Color(red: 0.027, green: 0.035, blue: 0.043)
    static let relayAccent = Color(red: 0.702, green: 0.753, blue: 0.769)
    static let relayLive = Color(red: 0.31, green: 0.765, blue: 0.608)
}
struct RelayView: View {
    @ObservedObject var model: RelayModel
    @State private var showDetails = false
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack { Image(systemName: "waveform.path").foregroundStyle(Color.relayAccent); Text("WAVBOUNCE").font(.custom("ShipporiMincho-Regular", size: 25)).tracking(3); Text("ECHO / AUDIO").font(.custom("IBMPlexMono-Regular", size: 9)).tracking(2).foregroundStyle(.secondary); Spacer() }
                VStack(alignment: .leading, spacing: 5) { Text("One space."); Text("Every device.").foregroundStyle(Color.relayAccent) }.font(.custom("ShipporiMincho-Regular", size: 42, relativeTo: .largeTitle))
                VStack(alignment: .leading, spacing: 18) {
                    Label("Listen to your computer", systemImage: "arrow.down.left").font(.custom("ShipporiMincho-Regular", size: 22, relativeTo: .title3))
                    Text("Start sharing on your Mac or Windows PC. Choose it below and approve the matching code there once.").foregroundStyle(.secondary).font(.subheadline)
                    HStack { Text("NEARBY COMPUTERS").font(.caption); Spacer(); Button("Refresh", action: model.refreshNearby).tint(.relayAccent) }
                    Text(model.discoveryStatus).font(.caption).foregroundStyle(.secondary)
                    ForEach(model.nearby) { device in Button(action: { model.connectNearby(device) }) { HStack { Text(device.name); Spacer(); Text("Connect"); Image(systemName: "arrow.down.left") } }.tint(.relayAccent) }
                    if let code = model.pairingCode { VStack(alignment: .leading, spacing: 8) { Text("CONFIRM ON THE SENDING COMPUTER").font(.caption); Text(code).font(.system(size: 32, design: .monospaced)); Text("Only approve if the codes match.").font(.caption) } }
                    if model.link.hasPrefix("{") { Button("Reconnect to saved computer", action: model.connect).tint(.relayAccent) }
                    DisclosureGroup("Use a pairing link") {
                    TextField("Pairing link", text: Binding(get: { model.link.hasPrefix("{") ? "" : model.link }, set: { model.link = $0 }), axis: .vertical).font(.system(.caption, design: .monospaced)).lineLimit(3...5).textInputAutocapitalization(.never).autocorrectionDisabled().padding(14).background(Color.relayBackground, in: RoundedRectangle(cornerRadius: 9))
                    Toggle("Remember this route securely", isOn: $model.remember).font(.subheadline).tint(.relayAccent)
                    Button(action: model.connect) { HStack { Text(model.active ? "Reconnect" : "Connect & listen"); Spacer(); Image(systemName: "arrow.down.left") }.padding(15).foregroundStyle(Color.relayAccent).overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.relayAccent, lineWidth: 1)) }.buttonStyle(.plain).disabled(model.link.isEmpty || model.link.hasPrefix("{"))
                    }
                }.padding(24).background(Color.relayPanel, in: RoundedRectangle(cornerRadius: 5)).overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.relayAccent.opacity(0.24), lineWidth: 1))
                VStack(spacing: 18) {
                    HStack { Text("NOW ROUTING").font(.caption2).tracking(2).foregroundStyle(.secondary); Spacer(); Text(model.connected ? "CONNECTED" : model.active ? "CONNECTING" : "READY").font(.caption2).tracking(1.5).foregroundStyle(model.connected ? Color.relayLive : Color.relayAccent) }
                    VStack(spacing: 10) { Text(model.sourceName).foregroundStyle(.secondary); Image(systemName: "arrow.down").foregroundStyle(Color.relayAccent); Text("This device").font(.title3) }.padding(.top, 10)
                    Text(model.status).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    GeometryReader { geo in Capsule().fill(Color.white.opacity(0.1)).overlay(alignment: .leading) { Capsule().fill(Color.relayLive).frame(width: geo.size.width * min(1, sqrt(model.level) * 1.8)) } }.frame(height: 3)
                    HStack { Text("Listening volume").font(.subheadline); Spacer(); Text("\(Int(model.volume * 100))%").monospacedDigit().foregroundStyle(.secondary) }
                    Slider(value: $model.volume, in: 0...1).tint(.relayAccent).accessibilityLabel("Listening volume")
                    HStack {
                        OutputPicker().frame(width: 42, height: 42).accessibilityLabel("Choose audio output")
                        Text("Audio output").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        if model.needsResume { Button("Resume", action: model.resume).tint(.relayAccent) }
                        Button("Stop", action: model.stop).tint(.relayAccent).disabled(!model.active)
                    }
                    DisclosureGroup("Connection details", isExpanded: $showDetails) {
                        VStack(spacing: 10) { row("Audio", "Opus stereo"); row("Received bitrate", model.bitrate); row("Audio buffer", model.buffer); row("Network jitter", model.jitter); row("Lost packets", model.lost); Text("Buffer and jitter are not total source-to-speaker delay.").font(.caption).foregroundStyle(.secondary) }.padding(.top, 15)
                    }.font(.subheadline).tint(.relayAccent)
                }.padding(24).background(Color.relayPanel, in: RoundedRectangle(cornerRadius: 5)).overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.relayAccent.opacity(0.24), lineWidth: 1))
                HStack { Text("Mac / Windows → iPad").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Forget saved route", action: model.forget).font(.caption).tint(.relayAccent) }
            }.padding(28).frame(maxWidth: 680)
        }.font(.custom("IBMPlexMono-Regular", size: 13, relativeTo: .body)).frame(maxWidth: .infinity).background(Color.relayBackground).preferredColorScheme(.dark)
            .onAppear { model.refreshNearby() }
            .onChange(of: scenePhase) { phase in if phase == .active { model.refreshNearby() } else if phase == .background { model.pauseDiscovery() } }
            .alert("WavBounce", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) { Button("OK") { model.error = nil } } message: { Text(model.error ?? "") }
    }
    func row(_ name: String, _ value: String) -> some View { HStack { Text(name).foregroundStyle(.secondary); Spacer(); Text(value).monospacedDigit() } }
}
