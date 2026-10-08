# Audio and pairing protocol

Desktop captures a single audio stream and creates up to four independent WebRTC peers. Opus stereo is negotiated over direct LAN ICE candidates without STUN/TURN. A single audio media section is accepted; video and data channels are rejected. Capture video tracks are discarded immediately. The UI does not process system audio samples.

Signaling is HTTPS/WSS at `/signal`. A source persists its certificate and preferred port. Bonjour `_wavbounce._tcp` TXT records advertise protocol `v=1`, `pairing=confirm-v1`, display name and public SHA-256 certificate fingerprint. Desktop additionally uses UDP47766 with nonce-bound same-subnet responses, bounded caches and rate limits. Discovery is unauthenticated; the display name is never an authority.

A receiver pins the exact source leaf certificate before sending authentication. A session link supplies a random, source-session capability. Alternatively a receiver sends `hello` with `v:1`, `method:device`, its Ed25519 raw public key encoded as unpadded base64url, and its display name. The source replies with a fresh 32-byte base64url nonce. The signed UTF-8 JSON array is exactly:

```
["WavBounce device pairing 1", sourceCertificatePin, nonce, clientPublicKey, clientName]
```

The receiver sends a base64url Ed25519 signature as `proof`. The six-digit code is SHA-256 of that transcript, first four bytes interpreted as an unsigned big-endian integer, modulo 1000000, padded with leading zeros. A new key gets no media before explicit source approval and matching-code comparison. Saved keys must prove possession on every connection. Nearby pins alone are not authenticated; the first code comparison is essential.

The source sends `welcome` after authentication, capacity and group checks. The receiver sends its audio-only `offer`; the source returns `answer`. WebRTC handles DTLS/SRTP media. At most four authenticated peers and twelve total pending/open WebSockets are admitted. Pairing requests expire and are bounded. Policy close1008 (capacity, revocation or source-side disconnect) stops automatic retry; manual Reconnect is required.

Friendly names and group membership persist separately from device approval. Source-side disconnect retains approval; revoke removes one approved key and its group membership. Selecting a group admits only its approved keys and rejects legacy capability-only connections. Deleting the selected group returns to unrestricted approved-device/session-link access. An empty selected group admits nobody.

Native Apple keys and saved source routes use Keychain. Desktop saved receiver routes use Electron safeStorage; desktop source identity/private keys and public approvals are private profile files. Do not publish app profiles or private links.
