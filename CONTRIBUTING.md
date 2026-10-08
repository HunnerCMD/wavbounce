# Contributing

Thanks for helping. WavBounce is MIT-licensed. By submitting a pull request, you agree that your contribution is released under the same license.

## Getting started

```sh
npm ci
npm test
npm start
```

Add a focused regression test for any protocol, lifecycle or access-control change. For capture, peer or UI changes, run the matching isolated audio integration test (`npm run test:headless`, `npm run test:mixer`, `npm run test:reconnect`, `npm run test:discovery`) after `npx playwright install chromium`. Run those one at a time.

## Ground rules

- Keep system-audio capture microphone-free. Open the microphone only for an explicit Microphone source.
- Keep explicit first-device approval, source Stop revocation, bounded discovery and static visuals.
- Never weaken a security behavior for Free users. Pro only raises listener and source limits and adds groups.
- Never use another person's active audio session as a test fixture. Keep test output muted and profiles temporary.
- Don't commit local profiles, pairing URLs, device identifiers, network captures, private screenshots or signing credentials.

In the pull request, describe the concrete behavior change, how you validated it, any platform limits and any protocol compatibility impact.
