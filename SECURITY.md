# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately using **[Report a vulnerability](../../security/advisories/new)** on this repository's Security tab. Don't open a public issue for security problems.

Don't include pairing links, private keys, local profile files, real device names or IP addresses. Reproduce with temporary identities and synthetic audio wherever possible.

## Supported versions

Only the latest release receives security fixes during the preview period.

## Security model in brief

- Discovery never authorizes audio. Each new device is approved on the source after comparing a six-digit code, and the connection is pinned to the source's TLS certificate.
- Revoking a device on the source removes it. Pressing Stop on the source invalidates the current session link.
- If you think a profile key is compromised, stop sharing, revoke the affected devices and pair them again.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for details.
