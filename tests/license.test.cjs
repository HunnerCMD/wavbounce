'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const License=require('../shared/license.cjs');
const {Entitlement}=require('../desktop/entitlement.cjs');

// Keys are signed with a fresh per-run Ed25519 pair, so these tests keep passing whichever
// public key shared/license.cjs embeds.
const crypto=require('node:crypto');
const pair=()=>crypto.generateKeyPairSync('ed25519'),OWNER=pair(),OTHER=pair();
const PUB=OWNER.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
function sign(payload,{privateKey}=OWNER){const bytes=Buffer.from(JSON.stringify(payload));return `WB1-${bytes.toString('base64url')}.${crypto.sign(null,bytes,privateKey).toString('base64url')}`;}
const base=()=>({v:1,product:'pro',id:crypto.randomUUID(),issued:new Date().toISOString()});
const VALID=sign(base()),VALID_WITH_NAME=sign({...base(),name:'Test Buyer'}),WRONG_KEY=sign(base(),OTHER);
const WRONG_PRODUCT=sign({...base(),product:'basic'}),WRONG_VERSION=sign({...base(),v:2});
const verify=key=>License.verify(key,PUB);
// Flip a character away from the end: a final base64url character can carry only padding bits,
// so changing it may decode to identical bytes.
const flipAt=(s,i)=>s.slice(0,i)+(s[i]==='A'?'B':'A')+s.slice(i+1);

test('a genuine license key verifies and returns its payload',()=>{
  const result=verify(VALID);
  assert.equal(result.valid,true);
  assert.equal(result.payload.product,'pro');assert.equal(result.payload.v,1);
  assert.equal(typeof result.payload.id,'string');assert.equal(typeof result.payload.issued,'string');
  const named=verify(VALID_WITH_NAME);assert.equal(named.valid,true);assert.equal(named.payload.name,'Test Buyer');
});
test('a tampered payload is rejected',()=>{
  const dot=VALID.indexOf('.'),i=4+Math.floor((dot-4)/2);
  const result=verify(flipAt(VALID,i));
  assert.equal(result.valid,false);assert.match(result.reason,/altered|genuine/i);
});
test('a tampered signature is rejected',()=>{
  const result=verify(flipAt(VALID,VALID.indexOf('.')+10));
  assert.equal(result.valid,false);assert.match(result.reason,/altered|genuine/i);
});
test('a key signed by the wrong private key is rejected',()=>{
  const result=verify(WRONG_KEY);
  assert.equal(result.valid,false);assert.match(result.reason,/altered|genuine/i);
});
test('wrong product or protocol version is rejected after a valid signature',()=>{
  assert.match(verify(WRONG_PRODUCT).reason,/Pro/);
  assert.match(verify(WRONG_VERSION).reason,/version/i);
});
test('malformed and oversize input is rejected without throwing',()=>{
  for(const bad of [undefined,null,42,{},[],'','not a license key','WB1-','WB1-abc','WB1-abc.def','x'.repeat(50),VALID+'x',VALID.replace('WB1-','WB2-')])
    assert.equal(verify(bad).valid,false,JSON.stringify(bad));
  assert.equal(verify('WB1-'+'A'.repeat(5000)+'.'+'A'.repeat(86)).valid,false);
});

test('entitlement activation persists and round-trips through a fresh instance',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-license-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=new Entitlement(directory,{publicKey:PUB});
  const loaded=await first.load();assert.equal(loaded.pro,false);assert.deepEqual(first.limits,{listeners:1,sources:1,groups:false});
  const activated=await first.activate(VALID_WITH_NAME);
  assert.equal(activated.pro,true);assert.equal(activated.name,'Test Buyer');assert.deepEqual(first.limits,{listeners:4,sources:4,groups:true});
  const second=new Entitlement(directory,{publicKey:PUB});const reloaded=await second.load();
  assert.equal(reloaded.pro,true);assert.equal(reloaded.name,'Test Buyer');assert.deepEqual(second.limits,{listeners:4,sources:4,groups:true});
  const removed=await second.remove();assert.equal(removed.pro,false);
  const third=new Entitlement(directory,{publicKey:PUB});assert.equal((await third.load()).pro,false);
});
test('activating an invalid key throws and leaves entitlement unchanged',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-license-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const entitlement=new Entitlement(directory,{publicKey:PUB});await entitlement.load();
  await assert.rejects(()=>entitlement.activate('garbage'),/license/i);
  assert.equal(entitlement.pro,false);
});
test('a malformed persisted license file fails closed to Free instead of throwing',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-license-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'pro-license.json'),'{not json',{mode:0o600});
  const entitlement=new Entitlement(directory,{publicKey:PUB});
  const state=await entitlement.load();
  assert.equal(state.pro,false);assert.deepEqual(entitlement.limits,{listeners:1,sources:1,groups:false});
  await fs.writeFile(path.join(directory,'pro-license.json'),JSON.stringify({v:1,key:'WB1-not-signed'}),{mode:0o600});
  const second=new Entitlement(directory,{publicKey:PUB});
  assert.equal((await second.load()).pro,false);
});
test('the embedded production key rejects keys from any other signer',()=>{
  assert.equal(License.verify(VALID).valid,false);
});
