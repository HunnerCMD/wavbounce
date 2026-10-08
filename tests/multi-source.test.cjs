'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {RelayNetwork}=require('../desktop/network.cjs');
const {ReceiverHub}=require('../desktop/receiver-hub.cjs');
async function until(check){const end=Date.now()+5000;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,15));}throw new Error('Timed out waiting for source state');}
const PRO={limits:{listeners:4,sources:4,groups:true}};
async function setup(t,count=3){
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-mixer-')),all=[];
  const make=async(name,options={})=>{const n=new RelayNetwork({directory:path.join(directory,name),name,discover:false,...options});all.push(n);await n.init();return n;};
  const receiver=await make('Mixer',{entitlement:PRO}),hub=new ReceiverHub(receiver);const sources=[];
  t.after(async()=>{hub.stop();for(const n of all)await n.close();await fs.rm(directory,{recursive:true,force:true});});
  for(let i=0;i<count;i++){const source=await make(`Source-${i+1}`);await source.share({host:'127.0.0.1'});sources.push(source);}
  return {hub,receiver,sources};
}
const route=s=>({kind:'device',name:s.name,pin:s.credentials.pin,host:'127.0.0.1',port:s.port});
async function approve(hub,source){const joined=hub.joinRoute(route(source));await until(()=>source.requests().length);const request=source.requests()[0];await until(()=>hub.snapshot().sources.some(s=>s.id===joined.id&&s.code===request.code));assert.equal(source.peers.size,0);await source.approvePair(request.id,true);await until(()=>source.peers.size===1);hub.connected(joined);return joined;}

test('three approved sources coexist; disconnect, retry, revoke and stale messages stay isolated',async t=>{
  const {hub,sources}=await setup(t);const joined=[];
  for(const source of sources)joined.push(await approve(hub,source));
  assert.equal(hub.snapshot().sources.length,3);const second=hub.sessions.get(joined[1].id).session.client;
  hub.remove(joined[0].id);await until(()=>sources[0].peers.size===0);assert.equal(second.readyState,1);assert.equal(sources[2].peers.size,1);
  const again=hub.joinRoute(route(sources[0]));await until(()=>sources[0].peers.size===1);assert.equal(sources[0].requests().length,0);hub.connected(again);
  const third=hub.sessions.get(joined[2].id);hub.retry(joined[2]);await until(()=>third.session.epoch>joined[2].epoch);assert.equal(second.readyState,1);
  // Old SDP and connected notifications must not affect a newer connection.
  hub.offer({...joined[2],description:{type:'offer',sdp:'invalid'}});hub.connected(joined[2]);assert.notEqual(third.state,'connected');
  await until(()=>sources[2].peers.size===1);hub.connected({id:third.id,epoch:third.session.epoch});
  await sources[0].revokeListener(hub.network.device.publicKey);await until(()=>hub.sessions.get(again.id).state==='pairing-needed');assert.equal(second.readyState,1);assert.equal(sources[2].peers.size,1);
  const reapproved=hub.joinRoute(route(sources[0]));assert.equal(reapproved.id,again.id,'Reconnect replaces only this source session');
  await until(()=>sources[0].requests().length>0);await sources[0].approvePair(sources[0].requests()[0].id,true);await until(()=>sources[0].peers.size===1);assert.equal(second.readyState,1);
  hub.stop();await until(()=>sources.every(s=>s.peers.size===0));assert.equal(hub.sessions.size,0);await new Promise(r=>setTimeout(r,900));assert.equal(sources.every(s=>s.peers.size===0),true);
});

test('duplicate, malformed, self and fifth sources preserve the current mix; sender role is protected',async t=>{
  const {hub,receiver,sources}=await setup(t,5);const joins=[];
  for(const source of sources.slice(0,4)){const j=hub.join(source.links('127.0.0.1').link);joins.push(j);await until(()=>source.peers.size===1);hub.connected(j);}
  assert.equal(hub.joinRoute(route(sources[0])).id,joins[0].id);assert.equal(sources[0].peers.size,1);
  assert.throws(()=>hub.join('broken'),/link/i);assert.throws(()=>hub.joinRoute(route(sources[4])),/four sources/i);
  assert.throws(()=>hub.joinRoute({...route(sources[0]),pin:receiver.credentials.pin}),/feedback/i);assert.equal(hub.sessions.size,4);
  hub.stop();await receiver.share({host:'127.0.0.1'});assert.throws(()=>hub.joinRoute(route(sources[0])),/Stop sharing/);assert.equal(receiver.role,'send');
});
