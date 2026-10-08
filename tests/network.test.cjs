const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {once}=require('node:events');
const {WebSocket}=require('ws');
const {RelayNetwork,PinnedAgent}=require('../desktop/network.cjs');
const P=require('../shared/protocol.cjs');
async function pair(t){
  const dir=await fs.mkdtemp(path.join(process.cwd(),'.test-data-'));
  const a=new RelayNetwork({directory:path.join(dir,'a'),name:'A',discover:false});
  const b=new RelayNetwork({directory:path.join(dir,'b'),name:'B',discover:false});
  t.after(async()=>{await a.close();await b.close();await fs.rm(dir,{recursive:true,force:true});});
  await Promise.all([a.init(),b.init()]);
  const links=await a.share();const route=P.parseLink(links.link);route.host='127.0.0.1';return {a,b,route,link:P.makeLink(route)};
}
test('trusted listener exchanges audio descriptions and Stop cancels reconnection',async t=>{
  const {a,b,link}=await pair(t);
  const welcome=once(b,'welcome');await b.join(link);await welcome;
  const sdp='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA:BB\r\n';
  const incoming=once(a,'offer');b.offer({type:'offer',sdp});const [offer]=await incoming;
  const answer=once(b,'answer');a.answer({id:offer.id,description:{type:'answer',sdp}});await answer;
  await b.stop();assert.equal(b.role,'idle');assert.equal(b.client,null);await new Promise(r=>setTimeout(r,900));assert.equal(b.client,null);
});
test('wrong capability cannot reach the audio offer handler',async t=>{
  const {a,route}=await pair(t);let seen=false;a.on('offer',()=>seen=true);
  const ws=new WebSocket(`wss://127.0.0.1:${route.port}/signal`,{agent:new PinnedAgent(route.pin)});t.after(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({type:'hello',v:1,token:P.secret(),name:'Unknown'}));const [code]=await once(ws,'close');assert.equal(code,1008);assert.equal(a.peers.size,0);assert.equal(seen,false);
});
test('certificate mismatch fails before any WebSocket authentication',async t=>{
  const {a,route}=await pair(t);let upgrades=0;a.server.on('upgrade',()=>upgrades++);
  const ws=new WebSocket(`wss://127.0.0.1:${route.port}/signal`,{agent:new PinnedAgent('0'.repeat(64))});
  const error=await new Promise(resolve=>ws.once('error',resolve));assert.match(error.message,/identity changed/);assert.equal(upgrades,0);ws.terminate();
});
test('sharing restart invalidates an earlier capability',async t=>{
  const {a,route}=await pair(t);const fresh=await a.share({port:route.port});assert.notEqual(P.parseLink(fresh.link).token,route.token);
  const ws=new WebSocket(`wss://127.0.0.1:${route.port}/signal`,{agent:new PinnedAgent(route.pin)});t.after(()=>ws.terminate());await once(ws,'open');ws.send(JSON.stringify({type:'hello',v:1,token:route.token,name:'Old'}));const [code]=await once(ws,'close');assert.equal(code,1008);
});
