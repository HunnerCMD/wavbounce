'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path');
const {RelayNetwork}=require('../desktop/network.cjs');
const {ReceiverHub}=require('../desktop/receiver-hub.cjs');
const next=(target,event)=>once(target,event,{signal:AbortSignal.timeout(5000)});
async function until(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,15));}throw new Error('Timed out waiting for state');}

// A mutable entitlement, like desktop/entitlement.cjs, so a test can flip Free/Pro on a
// live RelayNetwork/ReceiverHub the same way activating a license does in the app.
function makeEntitlement(pro){
  return {pro,get limits(){return this.pro?{listeners:4,sources:4,groups:true}:{listeners:1,sources:1,groups:false};}};
}

test('Free source: a second listener is rejected as Pro-needed while the first keeps playing',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-gate-'));
  const entitlement=makeEntitlement(false);
  const source=new RelayNetwork({directory:path.join(directory,'source'),discover:false,entitlement});
  const a=new RelayNetwork({directory:path.join(directory,'a'),name:'A',discover:false});
  const b=new RelayNetwork({directory:path.join(directory,'b'),name:'B',discover:false});
  t.after(async()=>{await a.close();await b.close();await source.close();await fs.rm(directory,{recursive:true,force:true});});
  await source.init();await source.share();await a.init();await b.init();
  const route={kind:'device',name:source.name,host:'127.0.0.1',port:source.port,pin:source.credentials.pin};
  const asking=next(source,'pair-requests');await a.joinRoute(route);const [[request]]=await asking;
  const welcomed=next(a,'welcome');await source.approvePair(request.id,true);await welcomed;a.connected();
  assert.equal(source.peers.size,1);

  const rejected=new Promise(resolve=>b.on('status',s=>{if(s.state==='pairing-needed')resolve(s);}));
  await b.joinRoute({...route,name:source.name});
  const result=await rejected;
  assert.match(result.message,/Pro is needed/i);
  assert.equal(source.peers.size,1,'the first listener is untouched by the rejected second one');
  assert.equal(a.client.readyState,1,'first listener keeps playing');
});

test('Pro source: up to four listeners connect',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-gate-'));
  const entitlement=makeEntitlement(true);
  const source=new RelayNetwork({directory:path.join(directory,'source'),discover:false,entitlement});
  const listeners=[];
  t.after(async()=>{for(const l of listeners)await l.close();await source.close();await fs.rm(directory,{recursive:true,force:true});});
  await source.init();await source.share();
  for(let i=0;i<4;i++){
    const l=new RelayNetwork({directory:path.join(directory,`l${i}`),name:`L${i}`,discover:false});listeners.push(l);await l.init();
    const route={kind:'device',name:source.name,host:'127.0.0.1',port:source.port,pin:source.credentials.pin};
    const asking=next(source,'pair-requests');await l.joinRoute(route);const [[request]]=await asking;
    const welcomed=next(l,'welcome');await source.approvePair(request.id,true);await welcomed;l.connected();
  }
  assert.equal(source.peers.size,4);
});

test('Free mixer: a second source is rejected as Pro-needed',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-gate-')),all=[];
  const entitlement=makeEntitlement(false);
  const make=async(name,options={})=>{const n=new RelayNetwork({directory:path.join(directory,name),name,discover:false,...options});all.push(n);await n.init();return n;};
  const receiver=await make('Mixer',{entitlement}),hub=new ReceiverHub(receiver);
  t.after(async()=>{hub.stop();for(const n of all)await n.close();await fs.rm(directory,{recursive:true,force:true});});
  const s1=await make('Source-1'),s2=await make('Source-2');await s1.share({host:'127.0.0.1'});await s2.share({host:'127.0.0.1'});
  const route=s=>({kind:'device',name:s.name,pin:s.credentials.pin,host:'127.0.0.1',port:s.port});
  const first=hub.joinRoute(route(s1));await until(()=>s1.requests().length);await s1.approvePair(s1.requests()[0].id,true);await until(()=>s1.peers.size===1);hub.connected(first);
  assert.throws(()=>hub.joinRoute(route(s2)),/Pro is needed/i);
  assert.equal(hub.sessions.size,1,'the first source keeps mixing');
  assert.equal(s1.peers.size,1);
});

test('Free source: saved listener groups cannot be created',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-gate-'));
  const entitlement=makeEntitlement(false);
  const source=new RelayNetwork({directory:path.join(directory,'source'),discover:false,entitlement});
  t.after(async()=>{await source.close();await fs.rm(directory,{recursive:true,force:true});});
  await source.init();
  assert.equal(source.listenerDevices().groupsAllowed,false);
  await assert.rejects(()=>source.saveListenerGroup({name:'Desk',keys:[]}),/Pro is needed/i);
});

test('activating Pro lifts limits on an already-running source without dropping the connected listener',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-gate-'));
  const entitlement=makeEntitlement(false);
  const source=new RelayNetwork({directory:path.join(directory,'source'),discover:false,entitlement});
  const a=new RelayNetwork({directory:path.join(directory,'a'),name:'A',discover:false});
  const b=new RelayNetwork({directory:path.join(directory,'b'),name:'B',discover:false});
  t.after(async()=>{await a.close();await b.close();await source.close();await fs.rm(directory,{recursive:true,force:true});});
  await source.init();await source.share();await a.init();await b.init();
  const route={kind:'device',name:source.name,host:'127.0.0.1',port:source.port,pin:source.credentials.pin};
  const asking=next(source,'pair-requests');await a.joinRoute(route);const [[request]]=await asking;
  const welcomed=next(a,'welcome');await source.approvePair(request.id,true);await welcomed;a.connected();
  assert.equal(source.listenerDevices().limit,1);

  entitlement.pro=true; // same live mutation desktop/entitlement.cjs performs on license activation
  assert.equal(source.listenerDevices().limit,4);
  const bAsking=next(source,'pair-requests');await b.joinRoute({...route});const [[bRequest]]=await bAsking;
  const bWelcomed=next(b,'welcome');await source.approvePair(bRequest.id,true);await bWelcomed;b.connected();
  assert.equal(source.peers.size,2,'the second listener now connects without restarting the source');
  assert.equal(a.client.readyState,1,'the first listener was never interrupted by the upgrade');
});
