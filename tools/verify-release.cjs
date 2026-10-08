'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const asar=require('@electron/asar'),resedit=require('resedit');const root=path.resolve(__dirname,'..');process.chdir(root);
const {verifyMacApp,verifyMacZip}=require('./verify-mac-signature.cjs');
const release=path.resolve(root,process.env.WAVBOUNCE_RELEASE_DIR||require('../package.json').build.directories.output||'release');
fs.mkdirSync(path.join(root,'evidence'),{recursive:true});
const {version}=require('../package.json'),report={version,timestamp:new Date().toISOString(),sourceMatches:[],artifacts:[],physicalWindowsTested:false,physicalIntelMacTested:false};
for(const archive of [path.join(release,'win-unpacked/resources/app.asar'),path.join(release,'mac-arm64/WavBounce.app/Contents/Resources/app.asar'),path.join(release,'mac/WavBounce.app/Contents/Resources/app.asar')]){
  for(const file of ['desktop/main.cjs','desktop/network.cjs','desktop/receiver-transport.cjs','desktop/receiver-session.cjs','desktop/receiver-hub.cjs','desktop/lan-discovery.cjs','desktop/listener-settings.cjs','desktop/preload.cjs','desktop/ui/app.js','desktop/ui/audio.js','desktop/ui/mixer.js','desktop/ui/index.html','desktop/ui/style.css','shared/protocol.cjs'])assert.deepEqual(asar.extractFile(archive,file),fs.readFileSync(file),`${archive}: ${file}`);
  const pkg=JSON.parse(asar.extractFile(archive,'package.json'));assert.equal(pkg.version,version);assert.equal(pkg.name,'wavbounce');report.sourceMatches.push(archive);
}
const executable=fs.readFileSync(path.join(release,'win-unpacked/WavBounce.exe'));assert.equal(executable.readUInt16LE(executable.readUInt32LE(0x3c)+4),0x8664);
const resources=resedit.NtExecutableResource.from(resedit.NtExecutable.from(executable));assert.ok(resources.entries.some(entry=>entry.type===14));
const info=resedit.Resource.VersionInfo.fromEntries(resources.entries)[0],strings=info.getStringValues(info.getAllLanguagesForStringValues()[0]);assert.equal(strings.ProductName,'WavBounce');assert.equal(strings.FileVersion,version);report.windowsVersion=strings.FileVersion;
report.macSignature=verifyMacApp(path.join(release,'mac-arm64/WavBounce.app'));
report.macArchiveSignature=verifyMacZip(path.join(release,`WavBounce-${version}-mac-arm64.zip`));
report.macIntelSignature=verifyMacApp(path.join(release,'mac/WavBounce.app'),'x64');
report.macIntelArchiveSignature=verifyMacZip(path.join(release,`WavBounce-${version}-mac-x64.zip`),'x64');
for(const name of [`WavBounce-Setup-${version}-win-x64.exe`,`WavBounce-${version}-win-x64.zip`,`WavBounce-${version}-mac-arm64.zip`,`WavBounce-${version}-mac-x64.zip`]){const data=fs.readFileSync(path.join(release,name));report.artifacts.push({name,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')});}
fs.writeFileSync(`evidence/release-verification-${version}.json`,JSON.stringify(report,null,2));fs.writeFileSync(path.join(release,`SHA256SUMS-${version}.txt`),report.artifacts.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');console.log(JSON.stringify(report,null,2));
