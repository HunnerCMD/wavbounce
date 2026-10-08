const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {once}=require('node:events');
const {RelayNetwork,deviceRoute}=require('../desktop/network.cjs');
const P=require('../shared/protocol.cjs');
const net=require('node:net');
const next=(emitter,event)=>once(emitter,event,{signal:AbortSignal.timeout(5000)});
async function setup(t){
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-reconnect-'));
  const sender=new RelayNetwork({directory:path.join(directory,'sender'),name:'Sender',discover:false});
  const receiver=new RelayNetwork({directory:path.join(directory,'receiver'),name:'Receiver',discover:false});
  t.after(async()=>{await receiver.close();await sender.close();await fs.rm(directory,{recursive:true,force:true});});
  await Promise.all([sender.init(),receiver.init()]);await sender.share();
  const link=P.makeLink({...P.parseLink(sender.links().link),host:'127.0.0.1'});
  const connected=next(receiver,'welcome');const saved=(await receiver.join(link)).route;await connected;receiver.connected();
  return {sender,receiver,saved,directory};
}
test('listener Stop then saved reconnect works while the sender keeps sharing',async t=>{
  const {sender,receiver,saved}=await setup(t);await receiver.stop();
  const connected=next(receiver,'welcome');await receiver.joinRoute(saved);await connected;assert.equal(sender.peers.size,1);
});
test('saved link reconnect after sender Stop/start reaches code approval without discovery',async t=>{
  const {sender,receiver,saved}=await setup(t);
  await receiver.stop();await sender.stop();await sender.share();
  const state=new Promise(resolve=>{
    sender.on('pair-requests',requests=>{if(requests.length)resolve({kind:'approval',request:requests[0]});});
    receiver.on('status',value=>{if(['reconnecting','pairing-needed'].includes(value.state))resolve({kind:value.state,message:value.message});});
  });
  await receiver.joinRoute(saved);
  const result=await Promise.race([state,new Promise(resolve=>{const timer=setTimeout(()=>resolve({kind:'timeout'}),4000);timer.unref();})]);
  assert.equal(result.kind,'approval',`Reconnect should reach code approval, got ${result.kind}: ${result.message||''}`);
  assert.equal(sender.peers.size,0,'an expired link must not silently authorize access');
  const connected=next(receiver,'welcome');await sender.approvePair(result.request.id,true);await connected;
  const route=deviceRoute(receiver.target);
  await receiver.stop();await sender.stop();await sender.share();
  const reconnected=next(receiver,'welcome');await receiver.joinRoute(route);await reconnected;
  assert.equal(sender.requests().length,0,'approved device reconnects without repeating approval');
});
test('sender endpoint remains stable across application restart without discovery',async t=>{
  const {sender,directory}=await setup(t);const oldPort=sender.port;await sender.close();
  const restarted=new RelayNetwork({directory:path.join(directory,'sender'),name:'Sender',discover:false});
  t.after(()=>restarted.close());await restarted.init();await restarted.share();assert.equal(restarted.port,oldPort);
});
test('occupied saved port falls back to a working endpoint with a notice',async t=>{
  const {sender}=await setup(t);const oldPort=sender.port;await sender.stop();
  const occupied=net.createServer();await new Promise(resolve=>occupied.listen(oldPort,'0.0.0.0',resolve));t.after(()=>new Promise(resolve=>occupied.close(resolve)));
  const notices=[];sender.on('notice',message=>notices.push(message));await sender.share();assert.notEqual(sender.port,oldPort);assert.ok(notices.some(message=>message.includes('occupied')));assert.equal(sender.server.listening,true);
});
