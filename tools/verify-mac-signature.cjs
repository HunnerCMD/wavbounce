'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stdout || ''}${result.stderr || ''}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function verifyMacApp(app, architecture = 'arm64') {
  assert.equal(process.platform, 'darwin', 'Mac signature verification requires macOS.');
  assert.ok(['arm64', 'x64'].includes(architecture), 'Expected Mac architecture arm64 or x64.');
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const info = run('codesign', ['--display', '--verbose=4', app]);
  assert.ok(info.includes(`Identifier=${pkg.build.appId}`), 'Unexpected Mac bundle signing identifier.');
  assert.match(info, /flags=.*\bruntime\b/, 'Hardened Runtime is required.');
  const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')]).trim();
  assert.equal(version, pkg.version, 'Unexpected Mac bundle version.');
  const minimumSystemVersion = run('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(app, 'Contents/Info.plist')]).trim();
  assert.equal(minimumSystemVersion, pkg.build.mac.minimumSystemVersion, 'Unexpected minimum macOS version.');
  const expectedMachArchitecture = architecture === 'x64' ? 'x86_64' : 'arm64';
  for (const binary of ['Contents/MacOS/WavBounce', 'Contents/Frameworks/Electron Framework.framework/Electron Framework']) {
    const architectures = run('lipo', ['-archs', path.join(app, binary)]).trim().split(/\s+/);
    assert.deepEqual(architectures, [expectedMachArchitecture], `Unexpected architecture in ${binary}.`);
  }
  return { version, architecture, minimumSystemVersion, signatureValid: true, hardenedRuntime: true, signing: info.includes('Signature=adhoc') ? 'ad-hoc' : 'certificate', notarizationVerified: false };
}

function verifyMacZip(zip, architecture = 'arm64') {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'wavbounce-mac-signature-'));
  try {
    run('ditto', ['-x', '-k', zip, staging]);
    return verifyMacApp(path.join(staging, 'WavBounce.app'), architecture);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { verifyMacApp, verifyMacZip };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const requireCertificate = args.includes('--require-certificate');
    if (requireCertificate) args.splice(args.indexOf('--require-certificate'), 1);
    let architecture = 'arm64';
    const archFlag = args.indexOf('--arch');
    if (archFlag !== -1) {
      architecture = args[archFlag + 1];
      args.splice(archFlag, 2);
    }
    assert.ok(['arm64', 'x64'].includes(architecture), 'Expected --arch arm64 or --arch x64.');
    assert.ok(args.length <= 1, 'Usage: verify-mac-signature.cjs [app-or-zip] [--arch arm64|x64]');
    const target = args[0] || path.resolve(root, process.env.WAVBOUNCE_RELEASE_DIR || pkg.build.directories.output, architecture === 'x64' ? 'mac/WavBounce.app' : 'mac-arm64/WavBounce.app');
    const result = target.endsWith('.zip') ? verifyMacZip(path.resolve(target), architecture) : verifyMacApp(path.resolve(target), architecture);
    assert.ok(!requireCertificate || result.signing === 'certificate', 'Expected a certificate-signed build (set WAVBOUNCE_SIGN_IDENTITY) but the app is ad-hoc signed.');
    console.log(JSON.stringify({ target, ...result }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
