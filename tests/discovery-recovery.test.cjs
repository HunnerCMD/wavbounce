const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path');
const dependency=require('bonjour-service'),original=dependency.Bonjour;
let instances=[],failConstruction=false;
class FakeBonjour {
  constructor(){if(failConstruction){failConstruction=false;throw Object.assign(new Error('Busy'),{code:'EADDRINUSE'});}this.server={mdns:new EventEmitter()};this.browser=new EventEmitter();this.browser.expire=()=>{};this.browser.update=()=>{};this.browser.stop=()=>{};this.published=[];instances.push(this);}
  find(){return this.browser;}
  publish(options){this.published.push(options);const service=new EventEmitter();service.stop=()=>{};return service;}
  destroy(){this.destroyed=true;}
}
dependency.Bonjour=FakeBonjour;
const {RelayNetwork}=require('../desktop/network.cjs');
dependency.Bonjour=original;
async function setup(t){instances=[];const directory=await fs.mkdtemp(path.join(process.cwd(),'.test-data-discovery-recovery-'));const network=new RelayNetwork({directory});t.after(async()=>{await network.close();await fs.rm(directory,{recursive:true,force:true});});await network.init();return network;}
test('Refresh restarts discovery after construction failed',async t=>{
  failConstruction=true;const network=await setup(t);assert.equal(instances.length,0);network.refreshDevices();assert.equal(instances.length,1,'Nearby must recover after startup failure');
});
test('Refresh replaces a failed discovery socket and republishes the active source',async t=>{
  const network=await setup(t);await network.share();const first=instances[0],port=network.port;
  first.server.mdns.emit('error',Object.assign(new Error('Busy'),{code:'EADDRINUSE'}));network.refreshDevices();
  assert.equal(instances.length,2,'Refresh must recreate a failed socket');assert.equal(first.destroyed,true);assert.equal(instances[1].published[0].port,port);assert.equal(network.server.listening,true,'discovery repair must preserve audio sharing');
});
test('Healthy discovery refresh keeps its socket and active source',async t=>{
  const network=await setup(t);await network.share();network.refreshDevices();network.refreshDevices();assert.equal(instances.length,1);assert.equal(instances[0].published.length,1);
});
