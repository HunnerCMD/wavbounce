const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path');const {once}=require('node:events');
const {WebSocket}=require('ws');const {RelayNetwork,PinnedAgent}=require('../desktop/network.cjs');const P=require('../shared/protocol.cjs');
async function setup(t,options={}){
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-pairing-'));
  const a=new RelayNetwork({directory:path.join(directory,'a'),name:'Test sender',discover:false,...options});
  const b=new RelayNetwork({directory:path.join(directory,'b'),name:'Test listener',discover:false});
  t.after(async()=>{await b.close();await a.close();await fs.rm(directory,{recursive:true,force:true});});
  await Promise.all([a.init(),b.init()]);await a.share();
  const discover=()=>b.recordService({fqdn:'sender._wavbounce._tcp.local',port:a.port,referer:{address:'127.0.0.1'},addresses:['192.0.2.2'],txt:{pin:a.credentials.pin,name:a.name,pairing:'confirm-v1'}});
  discover();return {a,b,directory,discover,id:b.devices()[0].id};
}
async function request(a,b,id){const asking=once(a,'pair-requests'),confirm=once(b,'pairing');const joined=await b.joinDevice(id);const [[requests],[code]]=await Promise.all([asking,confirm]);return {request:requests[0],code,route:joined.route};}
test('nearby pairing requires matching-code approval and remembers device identity across source restart',async t=>{
  const {a,b,id,discover,directory}=await setup(t);
  const {request:pending,code,route}=await request(a,b,id);
  assert.equal(pending.code,code.code);assert.match(code.code,/^\d{6}$/);assert.equal(a.peers.size,0,'no media access before approval');
  const welcome=once(b,'welcome');await a.approvePair(pending.id,true);await welcome;assert.equal(a.peers.size,1);
  const saved=JSON.parse(await fs.readFile(path.join(directory,'a/trusted-devices.json'),'utf8'));assert.ok(saved[b.device.publicKey]);
  await b.stop();await a.share();discover();let prompts=0;a.on('pair-requests',requests=>prompts+=requests.length);
  const again=once(b,'welcome');await b.joinRoute({...route,host:'127.0.0.2',port:1});await again;
  assert.equal(b.target.port,a.port,'discovery refreshes a stale saved port');assert.equal(b.target.host,'127.0.0.1');assert.equal(prompts,0,'approved device does not need another code');
  await a.forgetDevices();assert.deepEqual(a.trusted,{});assert.equal(a.role,'idle');
});
test('decline and Stop remove requests without authorizing the listener',async t=>{
  const {a,b,id}=await setup(t);const {request:pending}=await request(a,b,id);
  const ended=once(b,'receiver-reset');await a.approvePair(pending.id,false);await ended;assert.equal(a.peers.size,0);assert.deepEqual(a.trusted,{});
  await b.stop();const next=await request(a,b,id);await a.stop();assert.deepEqual(a.requests(),[]);await assert.rejects(()=>a.approvePair(next.request.id,true),/ended/);
});
test('unapproved connections cannot submit media offers',async t=>{
  const {a,b,id}=await setup(t);await request(a,b,id);let seen=false;a.on('offer',()=>seen=true);
  const reset=once(b,'receiver-reset');b.offer({type:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA:BB\r\n'});await reset;
  assert.equal(seen,false);assert.equal(a.peers.size,0);
});
test('a public device key alone cannot impersonate an approved listener',async t=>{
  const {a,b,id}=await setup(t);const {request:pending}=await request(a,b,id);const welcome=once(b,'welcome');await a.approvePair(pending.id,true);await welcome;await b.stop();
  const attacker=crypto.generateKeyPairSync('ed25519');const ws=new WebSocket(`wss://127.0.0.1:${a.port}/signal`,{agent:new PinnedAgent(a.credentials.pin)});t.after(()=>ws.terminate());await once(ws,'open');
  const challenge=once(ws,'message');ws.send(JSON.stringify({type:'hello',v:1,method:'device',key:b.device.publicKey,name:b.name}));const [data]=await challenge;const {nonce}=JSON.parse(data);
  const closed=once(ws,'close');ws.send(JSON.stringify({type:'proof',signature:crypto.sign(null,P.deviceProof(a.credentials.pin,nonce,b.device.publicKey,b.name),attacker.privateKey).toString('base64url')}));
  const [code]=await closed;assert.equal(code,1008);assert.equal(a.peers.size,0);
});
test('pairing requests expire and do not persist approval',async t=>{
  const {a,b,id}=await setup(t,{pairingTimeout:80});const gone=once(b,'receiver-reset');await request(a,b,id);await gone;assert.deepEqual(a.requests(),[]);assert.deepEqual(a.trusted,{});
});
test('device identity and approval survive both applications restarting',async t=>{
  const {a,b,id,directory}=await setup(t);const {request:pending,route}=await request(a,b,id);const welcome=once(b,'welcome');await a.approvePair(pending.id,true);await welcome;
  const receiverKey=b.device.publicKey;await b.close();await a.close();
  const source=new RelayNetwork({directory:path.join(directory,'a'),name:'Test sender',discover:false});const receiver=new RelayNetwork({directory:path.join(directory,'b'),name:'Test listener',discover:false});
  t.after(async()=>{await receiver.close();await source.close();});await Promise.all([source.init(),receiver.init()]);assert.equal(receiver.device.publicKey,receiverKey);assert.equal(source.credentials.pin,route.pin);await source.share();
  receiver.recordService({fqdn:id,port:source.port,referer:{address:'127.0.0.1'},addresses:[],txt:{pin:source.credentials.pin,name:source.name,pairing:'confirm-v1'}});
  let prompts=0;source.on('pair-requests',requests=>prompts+=requests.length);const connected=once(receiver,'welcome');await receiver.joinRoute(route);await connected;assert.equal(prompts,0);assert.equal(source.peers.size,1);
});
