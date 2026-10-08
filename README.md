# WavBounce

Private audio between your Mac and Windows computers, over your own network. Share one computer's system audio (or a microphone) with another computer, or mix several computers into one output. There's no cloud account, no server and no recording. Audio goes directly between your devices over pinned TLS and WebRTC/Opus.

> **Status: development preview (0.5.1).** It works day to day on Mac and Windows, but builds are not notarized or code-signed by a publisher yet. A native iPad/iPhone receiver is in development and can't send audio yet.

## Download

Get the latest build from the [Releases page](../../releases):

| Platform | File |
|---|---|
| Windows (x64) | `WavBounce-Setup-<version>-win-x64.exe` (installer) or `WavBounce-<version>-win-x64.zip` (portable) |
| Mac with Apple Silicon (M1 and later) | `WavBounce-<version>-mac-arm64.zip` |
| Mac with Intel | `WavBounce-<version>-mac-x64.zip` |

macOS 14.2 or later is required.

**First launch.** The builds aren't signed by a known publisher yet, so your OS will warn you:

- **Mac:** Unzip, drag WavBounce to Applications and open it. If macOS blocks it, go to **System Settings → Privacy & Security** and choose **Open Anyway** ([Apple's instructions](https://support.apple.com/en-us/102445)). Allow **Screen & System Audio Recording** when asked; WavBounce discards the video and uses only the audio.
- **Windows:** If SmartScreen appears, choose **More info → Run anyway**. If Windows Firewall asks, allow WavBounce on **private** networks.

Run one WavBounce per computer, with both computers on the same local network.

## Quick start

1. On the computer whose audio you want to hear, choose an audio source under **This computer**, then **Start sharing**.
2. On the listening computer, find the source under **Nearby devices** and choose **Connect**.
3. Check that both screens show the same six-digit code, then choose **Allow & remember** on the source. You only do this once per device.

After that, choose **Reconnect** on the listener whenever the source is sharing.

## Free and Pro

| Free | WavBounce Pro |
|---|---|
| One source to one listener at a time | One source to up to four listeners at a time |
| One source in the receiving mixer | Up to four mixed sources on a receiving computer |
| Full audio quality, Nearby pairing, reconnect | Same audio quality, pairing and reconnect |
| All security protections | Saved listener groups; same security protections |

Free never lowers audio quality or interrupts a working connection to show an upgrade prompt. Security works the same on both tiers. Adding a second listener or source is where Pro comes in: the new attempt gets a clear "WavBounce Pro is needed…" message and the existing connection keeps playing.

WavBounce Pro is a planned one-time $9.99 USD unlock. It's checked entirely offline against a signed license key, with no account and no server call. Purchases aren't open yet, so the app shows "Pro purchases open soon." To activate a key you already have, open **WavBounce Pro** in the app, paste the `WB1-…` key and choose **Activate**.

WavBounce is open source under the MIT license, so you're free to build it yourself. Buying Pro supports development.

## Mix multiple computers

1. Start sharing system audio on each source Mac or Windows PC.
2. On the receiving computer, choose **Connect** for each source under **Nearby devices**. Compare and approve each new device's code on its source.
3. Use **Your mix** to adjust each source's volume, mute it or disconnect it. Pick one output and set the master volume above the mix.
4. **Stop all** disconnects every source. Disconnecting or retrying one channel leaves the others running.

The mix plays locally through the selected output. It isn't forwarded to another device or exposed as a virtual microphone. Each computer either sends or receives at any one time. See [Mixer design](docs/MIXER.md).

## Listen on several computers

Repeat the quick start on up to four listeners (Pro). Each listener has its own output and volume.

**Your listeners** shows each approved device and its connection state. **Disconnect** frees the device's place but keeps its approval. **Revoke approval** disconnects the device and requires approval next time. **Rename** sets a friendly name on the source side.

Save groups such as Desk or Office using the approved-device checkboxes. Selecting a group disconnects listeners outside it and limits future connections to its members. Choose **All approved devices** to remove that restriction.

Each listener plays independently. This isn't synchronized multi-room playback.

## Use a microphone on another computer

Send a microphone (for example a Scarlett Solo) to another Mac so dictation apps there can use it, while apps on this Mac keep using the same microphone.

1. On the Mac with the microphone, choose **Microphone · <device>** under **Audio source**, then **Start sharing**. Allow microphone access the first time. Input 1 is sent centred on both channels with no echo cancellation, noise suppression or gain control.
2. On the other Mac, install a virtual audio device such as [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole). In WavBounce, choose it as the output, then connect to the source.
3. In the dictation app on that Mac, choose the virtual device (BlackHole 2ch) as its microphone.

Expect about 100 ms of added latency. This is one-way: the receiving Mac can't send back while it's listening.

## Privacy and security

- **The microphone stays off unless you choose it.** System-audio sharing never opens your microphone.
- **Nothing is recorded or sent to a server.** There's no account, analytics or cloud relay.
- **Every new device needs approval.** You compare a six-digit code, approve the device on the source, and the connection is pinned to that source's TLS certificate. Discovery alone never authorizes audio.
- **Stop ends the session for everyone.** Pressing Stop on the source ends every stream and invalidates the current session link. Approved devices stay remembered until you revoke them.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the protocol and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Reconnect and discovery

Keep sharing on at the source, then choose **Reconnect** on the listener. Approved device identities survive a source restart, and Nearby refreshes the saved source address while keeping its certificate identity.

Desktop discovery uses Bonjour, with a bounded private-LAN UDP fallback. Both devices must be on the same reachable network. Guest Wi-Fi isolation or blocked Bonjour can prevent discovery, and the app needs Local Network permission. A private pairing link is available as a manual fallback. Keep it private, and copy a fresh one after the source stops.

## Build from source

Requirements: Node.js 22, npm and git. Building a Windows installer on a Mac works without extra tools.

```sh
git clone https://github.com/HunnerCMD/wavbounce.git
cd wavbounce
npm ci
npm start            # run the desktop app
npm test             # protocol, network and license tests
```

Package installers (output goes to `release/<version>/`):

```sh
npm run pack:mac         # Apple Silicon, ad-hoc signed
npm run pack:mac:intel   # Intel, ad-hoc signed
npm run pack:windows     # Windows x64 installer + portable ZIP
```

macOS ties the Screen & System Audio Recording permission to the app's signature, and ad-hoc signatures change on every build. If you rebuild often, sign with a stable identity so you don't have to re-grant it each time:

```sh
WAVBOUNCE_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" npm run pack:mac:signed
```

### Integration tests

```sh
npx playwright install chromium
npm run test:headless    # four listeners, approval, revoke, rename, groups
npm run test:mixer       # three mixed sources, controls, reconnect isolation
npm run test:reconnect
npm run test:discovery
npm run test:lan
```

Run the audio tests one at a time on a machine with a graphical session. They use isolated profiles, muted synthetic stereo and Chromium's fake output stream, and they never capture real system audio. `npm run test:multi` is an optional harness that launches two desktop apps.

### iPad / iPhone (receive only, in development)

Install Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen), run `xcodegen generate --spec apple/project.yml`, open `apple/RelayAudio.xcodeproj`, choose your signing team and run the RelayAudio scheme on a device. It requires iOS 16+. The internal target name is RelayAudio, and the product is WavBounce.

## How it works

Capture runs once on the source, with a separate WebRTC/Opus connection for each listener at up to 256 kb/s stereo. The receiving mixer uses one Web Audio context with native gain nodes and no JavaScript audio-processing loop. Meters update at 1 Hz, and only while the window is visible. The desktop app is Electron, so expect Chromium's usual helper-process memory use.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Hunter Candari. Third-party components keep their own licenses; see [THIRD-PARTY.md](THIRD-PARTY.md).
