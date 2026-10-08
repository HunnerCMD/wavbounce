# Third-party components

Desktop dependency versions are pinned in package-lock.json. Electron embeds Chromium and WebRTC; its distribution includes LICENSE and LICENSES.chromium.html. Keep those files with redistributed builds. Runtime packages include ws (MIT), bonjour-service (MIT), qrcode (MIT), and selfsigned (MIT); their transitive notices remain in the packaged node_modules.

The Apple target pins stasel/WebRTC 152.0.0, a community binary distribution of upstream WebRTC. See https://github.com/stasel/WebRTC/blob/152.0.0/LICENSE.md and https://webrtc.googlesource.com/src/+/refs/heads/main/LICENSE. Retain the framework's licenses when distributing. No AudioRelay or SonoBus source is included.

The bundled IBM Plex Mono and Shippori Mincho fonts are under the SIL Open Font License 1.1. Their license files accompany the desktop fonts and Apple resources. The WavBounce application icon is original project artwork, covered by this project's MIT license.
