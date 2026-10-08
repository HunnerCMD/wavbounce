# Before public distribution

Record app version, hardware, network type and exact artifact hash for every result. Automated development tests and package checks are separate from installation and physical listening.

| Test | Required evidence |
|---|---|
| Windows → Mac and Mac → Windows | Real system capture, left/right audio, installer and portable launch |
| 2 then 3 source computers → one Mac/Windows receiver | Independent stereo, channel/master controls, output choice and source disconnect/reconnect isolation |
| Three-source 30-minute mix | CPU, memory, bandwidth, audible dropouts, master headroom, sleep/wake and output removal |
| One source → 2 then 4 physical devices | Each device audible, independent output/volume, no interruption when another leaves |
| Stop, disconnect, revoke and reconnect | Remaining listeners continue; revoked device must request approval |
| Wi-Fi loss and source restart | Bounded recovery, no duplicate peers or stale playback |
| 30-minute four-listener run | CPU, memory, bandwidth, packet loss, concealment and audible dropouts |
| iPad from either desktop | Nearby/code approval, remembered reconnect, audible stereo |
| iPad background and outputs | Screen lock, app switching, calls, headphones/Bluetooth unplug and Resume |
| Public installers | Windows install/uninstall and signing; Mac signing/notarization and launch |
| Repository | License chosen, exact source export reviewed, dependency notices, no private files |
| App Store | Physical acceptance, signing, SDK/privacy review, support/privacy pages, final submission approval |

Do not market synchronized room speakers; this build uses independent receiver timing. The displayed buffer is not measured source-to-speaker latency.

Apple discovery uses declared Bonjour services and Local Network permission. Raw multicast/broadcast fallback on iOS would require additional entitlement review; it is not implemented. Reference: [Apple local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
