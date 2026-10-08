# Multiple sources, one output

Desktop source version 0.4.0 adds a receiver mixer for up to four Mac/Windows source sessions. The first acceptance scenario is a Windows PC and a MacBook feeding one receiving computer, then a third desktop source. The iPad app remains a receiver; iPad sending is not part of this implementation.

## Behavior

Choose Connect beside each source in Nearby. Each source approves the receiver's own comparison code independently. A source gets one row with its state, volume, mute and disconnect. The receiver has one output selector, a master volume/mute and Stop all. Adding a fifth source produces a capacity message. A duplicate source certificate does not create a second channel.

Each source reconnects independently. An authentication rejection waits for an explicit reconnect/approval; other channels keep playing. A malformed manual link does not stop existing audio. Output failure suspends the entire mix until the user selects a working output. Stop cancels all sessions and closes the mix context. Removing the last source suspends the idle context; the next Connect resumes it.

Channel volumes and mutes last for the current session. Source approvals persist on their respective computers. The existing quick-reconnect slot remembers the most recently saved source route; it does not restore a saved multi-source mix. No billing or feature gates are enabled.

The receiving computer does not capture or forward its mix. It cannot share system audio while receiving, and its own certificate is rejected as an input. This avoids an application-created feedback path. Local applications still use normal operating-system output routing.

## Implementation

- `receiver-transport.cjs` owns certificate pin validation and validated device routes.
- `ReceiverSession` owns one pinned TLS/WebSocket connection, device proof, approval, SDP events, phase timers and reconnect generation. The existing one-receiver network interface delegates to it too.
- `ReceiverHub` shares the desktop discovery service and device identity across four independent sessions. Source IDs and connection epochs accompany media messages so delayed work cannot alter a replacement connection. Source and listener counts are separate limits.
- `ReceiverMixer` owns one Web Audio context and a WebRTC receiver for each source. Native gain nodes combine stereo streams. Each source has a permanently muted media element because Chromium needs an active media renderer to drain its WebRTC jitter buffer; only the mixed graph reaches audible output.
- The mix gain is divided by the sum of channel volume settings, with a minimum divisor of one, before master volume. Muting or temporarily losing a channel retains that balance. Adding/removing a channel or changing its volume can adjust the overall headroom. This is not a calibrated true-peak limiter.
- A single one-second timer reads connection statistics and a small mixed-level sample while the window is visible. No decorative animation or JavaScript PCM processing is in the playback path. Decoder CPU and bandwidth still grow with active sources; physical resource measurements remain pending.

The wire protocol remains version1 and audio-only. Existing desktop senders can connect without changing their source role or exposing new discovery credentials. Each input keeps its own jitter buffer; the feature does not align different sources to a shared recording clock or provide synchronized speaker playback.

## iPad sending boundary

Sending audio from other iPad apps needs a ReplayKit Broadcast Upload Extension and a system broadcast picker started by the user. The current native project has neither a broadcast sender nor its audio-input bridge. That work also needs a bounded encoder/transport implementation compatible with extension lifecycle limits, private destination approval, and physical background/interruption testing. Discard video and microphone buffers rather than transmitting them.

Apple documents user-initiated system broadcasting and the separate extension process in [ReplayKit security](https://support.apple.com/guide/security/replaykit-security-seca5fc039dd/web). Apple also says some apps prevent audio/video capture in [screen recording guidance](https://support.apple.com/en-us/102653), and lists an AVPlayer limitation in [ReplayKit documentation](https://developer.apple.com/documentation/replaykit). These constraints mean WavBounce must not promise capture of every iPad app or protected stream. References checked September 9, 2026.

Before building the iPad sender, identify the target apps and verify that their audio is available through a user-started ReplayKit prototype on the physical iPad. Then integrate a source transport and validate that the receiving mix stays active when the iPad pauses, backgrounds or ends its broadcast. No silent capture or capture restriction bypass is planned.

## Development evidence

Thirty protocol/network tests cover existing authorization, discovery and listener behavior plus source isolation, duplicate/capacity handling, reconnect after revocation and stale-message rejection. `tests/headless-mixer.cjs` verifies three real TLS/WebRTC stereo sources, the actual mixer UI, channel/master controls, disconnect/reconnect isolation, output-loss pause, Stop cleanup and narrow-screen layout in one hidden browser. `tests/headless-multi.cjs` separately verifies one source feeding four receivers.

Both browser tests use Chromium's `--disable-audio-output`, which selects its [fake audio output stream](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/audio/audio_manager_base.cc). Media encoding, decoding, signaling and graph mixing remain real; acoustic output is not tested. An earlier physical-output-backed browser run had a stalled audio clock, so this test mode also removes that hardware dependency. It does not prove production Electron IPC, installed Windows/Mac capture, physical iPad support, long listening, CPU or battery performance. The 0.4.0 Windows x64 installer/ZIP and Apple Silicon Mac app/ZIP are built in `release/0.4.0/`. Windows installation, one-instance launch, new UI, restored sharing and remembered listener reconnect are now verified by the connected PC task; audible playback was not independently tested. The original Mac package's invalid bundle signature was repaired. Its local ad-hoc signature and fresh ZIP extraction now pass strict verification; source equality and corrected download hashes also pass. The Mac preview is still not Apple-notarized and requires owner security approval. Corrected Mac opening and physical multi-source audio acceptance remain pending.
