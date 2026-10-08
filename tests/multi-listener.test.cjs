const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {once}=require('node:events');const {RelayNetwork}=require('../desktop/network.cjs');
const next=(target,event)=>once(target,event,{signal:AbortSignal.timeout(5000)});
const PRO={limits:{listeners:4,sources:4,groups:true}};
async function setup(t,count=2){
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-multi-'));const source=new RelayNetwork({directory:path.join(directory,'source'),discover:false,entitlement:PRO});const listeners=[];
  t.after(async()=>{for(const l of listeners)await l.close();await source.close();await fs.rm(directory,{recursive:true,force:true});});await source.init();await source.share();
  for(let i=0;i<count;i++){const l=new RelayNetwork({directory:path.join(directory,`listener-${i}`),name:`Listener ${i+1}`,discover:false});listeners.push(l);await l.init();const route={kind:'device',name:source.name,host:'127.0.0.1',port:source.port,pin:source.credentials.pin};l.savedRoute=route;const asking=next(source,'pair-requests');await l.joinRoute(route);const [[request]]=await asking;const welcomed=next(l,'welcome');await source.approvePair(request.id,true);await welcomed;l.connected();}
  return {source,listeners,directory};
}
test('disconnect and revoke affect only the chosen listener',async t=>{
  const {source,listeners:[a,b]}=await setup(t);const rows=source.listenerDevices();assert.equal(rows.connected,2);assert.equal(rows.limit,4);
  const row=rows.devices.find(d=>d.key===a.device.publicKey),ended=next(a,'receiver-reset');source.disconnectListener(row.id);await ended;assert.equal(source.peers.size,1);assert.ok(source.trusted[a.device.publicKey]);assert.equal(b.client.readyState,1);
  const welcomed=next(a,'welcome');await a.joinRoute(a.savedRoute);await welcomed;
  const revoked=next(a,'receiver-reset');await source.revokeListener(a.device.publicKey);await revoked;assert.equal(source.peers.size,1);assert.ok(!source.trusted[a.device.publicKey]);assert.equal(b.client.readyState,1);
  const asking=next(source,'pair-requests');await a.joinRoute(a.savedRoute);const [[request]]=await asking;assert.equal(request.key,undefined,'private implementation details are not exposed in approval prompts');assert.equal(source.peers.size,1,'revoked listener needs approval again');
});
test('four listeners connect and a fifth receives a clear capacity response',async t=>{
  const {source,listeners,directory}=await setup(t,4);assert.equal(source.peers.size,4);const fifth=new RelayNetwork({directory:path.join(directory,'fifth'),discover:false});listeners.push(fifth);await fifth.init();const status=new Promise(resolve=>fifth.on('status',s=>{if(s.state==='pairing-needed')resolve(s);}));await fifth.join(source.links('127.0.0.1').link.replace(/host=[^&]+/,'host=127.0.0.1'));const result=await Promise.race([status,new Promise(resolve=>setTimeout(()=>resolve({message:'timeout'}),1500))]);assert.match(result.message,/four listener/i);assert.equal(source.peers.size,4);
});
test('friendly names and approved-device groups persist and never auto-start capture',async t=>{
  const {source,listeners:[a,b],directory}=await setup(t);await source.renameListener(a.device.publicKey,'Desk speakers');const group=await source.saveListenerGroup({name:'Desk',keys:[a.device.publicKey]});const ended=next(b,'receiver-reset');await source.selectListenerGroup(group.id);await ended;assert.equal(source.peers.size,1);assert.equal(source.listenerDevices().devices.find(d=>d.key===a.device.publicKey).name,'Desk speakers');
  await assert.rejects(()=>source.saveListenerGroup({name:'Unknown',keys:['x'.repeat(43)]}),/approved/i);
  await source.close();const restarted=new RelayNetwork({directory:path.join(directory,'source'),discover:false});t.after(()=>restarted.close());await restarted.init();assert.equal(restarted.role,'idle');assert.equal(restarted.listenerDevices().selectedGroup,group.id);assert.equal(restarted.listenerDevices().devices.find(d=>d.key===a.device.publicKey).name,'Desk speakers');
});
