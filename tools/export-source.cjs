'use strict';
// Stage only audited source categories for the public MIT repository. Review the output before publishing.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
 await fs.mkdir(path.join(root,'.build'),{recursive:true});
 const destination=await fs.mkdtemp(path.join(root,'.build',`public-source-${version}-`));
 const roots=['desktop','shared','assets','apple/RelayAudio','.github','tests'];
 const files=['LICENSE','package.json','package-lock.json','.gitignore','README.md','THIRD-PARTY.md','CONTRIBUTING.md','SECURITY.md','apple/project.yml','apple/Info.plist','docs/PROTOCOL.md','docs/ACCEPTANCE.md','docs/MIXER.md','tools/prepare-icons.py','tools/verify-release.cjs','tools/verify-mac-signature.cjs','tools/export-source.cjs','tools/issue-license.cjs'];
 const manifest=[];
 async function copy(relative){const source=path.join(root,relative),stat=await fs.lstat(source);if(stat.isSymbolicLink())throw new Error(`Symlink excluded: ${relative}`);if(stat.isDirectory()){for(const entry of await fs.readdir(source))await copy(path.join(relative,entry));return;}
  if(!/\.(cjs|js|json|md|html|css|ttf|woff2|txt|png|ico|icns|swift|plist|yml|py)$/.test(relative)&&relative!=='.gitignore'&&relative!=='LICENSE')throw new Error(`Unexpected source type: ${relative}`);
  const bytes=await fs.readFile(source);
  if(/\.(cjs|js|json|md|html|css|swift|plist|yml|py)$/.test(relative)&&(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString())||/wavbounce:\/\/join\?[^\s"']*token=[A-Za-z0-9_-]{43}/.test(bytes.toString())||/\/Users\/hunter\//.test(bytes.toString())))throw new Error(`Private material requires review: ${relative}`);
  await fs.mkdir(path.dirname(path.join(destination,relative)),{recursive:true});await fs.writeFile(path.join(destination,relative),bytes);manifest.push({file:relative,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 for(const relative of [...roots,...files])await copy(relative);
 await fs.mkdir(path.join(destination,'evidence'));await fs.mkdir(path.join(destination,'.build'));
 await fs.writeFile(path.join(destination,'SOURCE-MANIFEST.json'),JSON.stringify({version,license:'MIT',files:manifest},null,2));
 console.log(JSON.stringify({destination,files:manifest.length,published:false,license:'MIT'}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
