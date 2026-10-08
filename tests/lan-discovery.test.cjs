const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter,once}=require('node:events'),fs=require('node:fs/promises'),path=require('node:path');
// mDNS is alive but no announcements reach the app, matching the physical LAN.
const dependency=require('bonjour-service'),original=dependency.Bonjour;
class SilentBonjour {
  constructor(){this.server={mdns:new EventEmitter()};}
  find(){const browser=new EventEmitter();for(const name of ['update','expire','stop'])browser[name]=()=>{};return browser;}
  publish(){const service=new EventEmitter();service.stop=()=>{};return service;}
  destroy(){}
}
dependency.Bonjour=SilentBonjour;const {RelayNetwork}=require('../desktop/network.cjs');dependency.Bonjour=original;
test('Nearby finds and pairs a LAN source when mDNS announcements never arrive',async t=>{
  const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-lan-'));
  const source=new RelayNetwork({directory:path.join(directory,'source'),name:'LAN test source'}),listener=new RelayNetwork({directory:path.join(directory,'listener')});
  t.after(async()=>{await listener.close();await source.close();await fs.rm(directory,{recursive:true,force:true});});
  await source.init();await source.share();await listener.init();
  const found=await new Promise(resolve=>{const timeout=setTimeout(()=>resolve(null),10000);listener.on('devices',devices=>{const d=devices.find(d=>d.pin===source.credentials.pin);if(d){clearTimeout(timeout);resolve(d);}});listener.refreshDevices();});
  assert.ok(found,'Sharing source must appear in Nearby without mDNS or a pasted link');
  const request=once(source,'pair-requests',{signal:AbortSignal.timeout(3000)});await listener.joinDevice(found.id);const [requests]=await request;assert.equal(requests.length,1);assert.equal(source.peers.size,0,'discovery never grants audio access');
  const welcome=once(listener,'welcome',{signal:AbortSignal.timeout(3000)});await source.approvePair(requests[0].id,true);await welcome;listener.connected();
  assert.equal(source.peers.size,1);
  const gone=once(listener.lan,'down',{signal:AbortSignal.timeout(3000)});await source.stop();assert.equal((await gone)[0],source.credentials.pin);assert.ok(!listener.devices().some(d=>d.pin===source.credentials.pin),'Stop removes the LAN entry');
});
test('LAN responses must match an outstanding query and the local subnet',()=>{
  const {LanDiscovery,parsePacket}=require('../desktop/lan-discovery.cjs');
  const lan=new LanDiscovery();lan.interfaces=[{address:'10.0.0.10',network:0x0a000000,mask:0xffffff00,broadcast:'10.0.0.255'}];
  const nonce='b'.repeat(24),pin='c'.repeat(64);lan.pending.set(nonce,{at:Date.now()});
  const packet=Buffer.from(JSON.stringify({tag:'wavbounce-lan-1',type:'source',nonce,pin,name:'Peer',port:12345,host:'203.0.113.1'}));
  lan.receive(packet,{address:'203.0.113.1',port:47766});assert.equal(lan.peers.size,0);
  lan.receive(packet,{address:'10.0.0.20',port:9});assert.equal(lan.peers.size,0);
  lan.receive(Buffer.from(packet.toString().replace(nonce,'d'.repeat(24))),{address:'10.0.0.20',port:47766});assert.equal(lan.peers.size,0);
  lan.receive(packet,{address:'10.0.0.20',port:47766});assert.equal(lan.peers.get(pin).host,'10.0.0.20','route uses observed address, never an advertised redirect');
  assert.equal(parsePacket(Buffer.alloc(1025)),null);assert.equal(parsePacket(Buffer.from('{bad')),null);
  lan.pending.get(nonce).at=Date.now()-45001;lan.peers.clear();lan.receive(packet,{address:'10.0.0.20',port:47766});assert.equal(lan.peers.size,0);lan.close();
});
