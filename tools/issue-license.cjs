'use strict';
// Offline license signing tool. Never run this against the repo's own directory tree —
// the private signing key must live outside git, in the owner's home directory.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const REPO_ROOT=path.resolve(__dirname,'..');
const KEY_DIR=path.join(os.homedir(),'.wavbounce');
const KEY_FILE=path.join(KEY_DIR,'license-signing-key.pem');
function refuseInsideRepo(target){
  const resolved=path.resolve(target);
  if(resolved===REPO_ROOT||resolved.startsWith(REPO_ROOT+path.sep))throw new Error(`Refusing to write a signing key inside the repository: ${resolved}`);
}
function publicKeyB64Url(publicKey){return publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url');}
function init(){
  refuseInsideRepo(KEY_FILE);
  fs.mkdirSync(KEY_DIR,{recursive:true,mode:0o700});
  if(fs.existsSync(KEY_FILE))throw new Error(`Refusing to overwrite the existing signing key at ${KEY_FILE}. A new key invalidates every license already issued with the old one; move or delete that file first if that is really what you want.`);
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(KEY_FILE,privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  fs.chmodSync(KEY_FILE,0o600);
  console.log(`Signing key written to ${KEY_FILE} (mode 0600). Keep it private; never commit it.`);
  console.log('Paste this value into shared/license.cjs as PUBLIC_KEY_B64URL:');
  console.log(publicKeyB64Url(publicKey));
}
function loadPrivateKey(){
  if(!fs.existsSync(KEY_FILE))throw new Error(`No signing key at ${KEY_FILE}. Run: node tools/issue-license.cjs init`);
  return crypto.createPrivateKey(fs.readFileSync(KEY_FILE,'utf8'));
}
function issue({name}={}){
  const privateKey=loadPrivateKey();
  const payload={v:1,product:'pro',id:crypto.randomUUID(),...(name?{name}:{}),issued:new Date().toISOString()};
  const payloadBytes=Buffer.from(JSON.stringify(payload));
  const signature=crypto.sign(null,payloadBytes,privateKey);
  const key=`WB1-${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`;
  console.log(key);
  return key;
}
function parseArgs(argv){const out={};for(let i=0;i<argv.length;i++)if(argv[i]==='--name')out.name=argv[++i];return out;}
function main(){
  const [,,command,...rest]=process.argv;
  if(command==='init')return init();
  if(command==='issue'){
    const {name}=parseArgs(rest);
    if(name!==undefined&&(typeof name!=='string'||!name.trim()||name.length>80))throw new Error('--name must be 1-80 characters.');
    return issue({name:name?.trim()});
  }
  console.error('Usage: node tools/issue-license.cjs init | issue --name "Buyer Name"');
  process.exitCode=1;
}
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={init,issue,publicKeyB64Url,KEY_FILE,KEY_DIR};
