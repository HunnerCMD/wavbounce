'use strict';
const {EventEmitter}=require('node:events');
const https=require('node:https'),net=require('node:net');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {X509Certificate}=crypto;
const selfsigned=require('selfsigned');
const {WebSocketServer,WebSocket}=require('ws');
const {Bonjour}=require('bonjour-service');
const {LanDiscovery}=require('./lan-discovery.cjs');
const {ListenerSettings}=require('./listener-settings.cjs');
const P=require('../shared/protocol.cjs');
const {PinnedAgent,cleanName,deviceRoute}=require('./receiver-transport.cjs');
const {ReceiverSession}=require('./receiver-session.cjs');
const FREE_ENTITLEMENT={limits:{listeners:1,sources:1,groups:false}};

async function identity(directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'identity.json');
  try{const saved=JSON.parse(await fs.readFile(file,'utf8'));const cert=new X509Certificate(saved.cert);if(Date.parse(cert.validTo)>Date.now()+86400000&&saved.key)return {...saved,pin:P.fingerprint(cert.raw)};}
  catch(error){if(error.code&&error.code!=='ENOENT')throw error;}
  const pems=await selfsigned.generate([{name:'commonName',value:'WavBounce'}],{keySize:2048,algorithm:'sha256',days:365});
  const value={cert:pems.cert,key:pems.private};await fs.writeFile(file,JSON.stringify(value),{mode:0o600});
  return {...value,pin:P.fingerprint(new X509Certificate(value.cert).raw)};
}
async function deviceIdentity(directory){
  const file=path.join(directory,'device-key.json');
  try{const value=JSON.parse(await fs.readFile(file,'utf8'));const key=crypto.createPrivateKey(value.privateKey);const publicKey=crypto.createPublicKey(key).export({format:'der',type:'spki'}).subarray(-32).toString('base64url');if(key.asymmetricKeyType!=='ed25519')throw new Error('Invalid saved device identity.');return {privateKey:key,publicKey};}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
  await fs.writeFile(file,JSON.stringify({privateKey:privateKey.export({format:'pem',type:'pkcs8'})}),{mode:0o600});
  return {privateKey,publicKey:publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url')};
}
function addresses(){
  const all=Object.entries(os.networkInterfaces()).flatMap(([name,items])=>(items||[]).filter(i=>i.family==='IPv4'&&!i.internal&&!i.address.startsWith('169.254.')).map(i=>({name,address:i.address})));
  const weight=i=>Number(i.address.startsWith('100.'))*4+Number(/virtual|vethernet|vmware|vbox|docker|wsl/i.test(i.name))*2;
  return all.sort((a,b)=>weight(a)-weight(b));
}
class RelayNetwork extends EventEmitter {
  constructor({directory,name=os.hostname().replace(/\.local$/,''),discover=true,pairingTimeout=60000,mdns=true,lanDiscovery=true,entitlement=FREE_ENTITLEMENT}){
    super();Object.assign(this,{directory,name:cleanName(name),discover,pairingTimeout,useMdns:mdns,lanEnabled:lanDiscovery,entitlement});this.peers=new Map();this.peerInfo=new Map();this.listenerSettings=new ListenerSettings(directory);this.pending=new Map();this.discovered=new Map();this.trusted={};this.generation=0;this.retry=0;this.role='idle';
  }
  listenerCapacityMessage(){return this.entitlement.limits.listeners<=1?'WavBounce Pro is needed for a second listener. This connection keeps playing.':'All four listener places are in use.';}
  async init(){
    this.credentials=await identity(this.directory);this.device=await deviceIdentity(this.directory);
    await this.listenerSettings.load();
    try{const saved=JSON.parse(await fs.readFile(path.join(this.directory,'listen-port.json'),'utf8'));if(Number.isInteger(saved.port)&&saved.port>=1024&&saved.port<=65535)this.preferredPort=saved.port;}catch(error){if(error.code!=='ENOENT')this.emit('notice','The saved connection address could not be read. A new address will be used.');}
    try{const value=JSON.parse(await fs.readFile(path.join(this.directory,'trusted-devices.json'),'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))for(const [key,entry]of Object.entries(value)){if(/^[A-Za-z0-9_-]{43}$/.test(key))this.trusted[key]={name:cleanName(entry.name)};}}catch(error){if(error.code!=='ENOENT')this.emit('notice','Saved device approvals could not be read. Confirm the devices again.');}
    if(this.discover){
      if(this.lanEnabled){this.lan=new LanDiscovery();
      this.lan.on('up',peer=>{if(peer.pin===this.credentials.pin)return;this.discovered.set(`lan:${peer.pin}`,{id:`lan:${peer.pin}`,name:cleanName(peer.name),host:peer.host,hosts:[peer.host],port:peer.port,pin:peer.pin,pairable:true});this.emit('devices',this.devices());});
      this.lan.on('down',pin=>{this.discovered.delete(`lan:${pin}`);this.emit('devices',this.devices());});
      this.lan.on('notice',message=>this.emit('notice',message));this.lan.start();}
      this.startDiscovery();
      this.discoveryTimer=setInterval(()=>this.refreshDevices(),15000);this.discoveryTimer.unref?.();
    }
    return {name:this.name,addresses:addresses(),devices:this.devices(),discovery:this.discoveryStatus};
  }
  reportDiscovery(state,message,code){
    this.discoveryStatus={state,message,...(code?{code}:{}),at:new Date().toISOString()};
    this.emit('discovery-status',this.discoveryStatus);
  }
  startDiscovery(){
    if(!this.discover||this.discoveryClosed||!this.useMdns)return;
    const generation=this.discoveryGeneration=(this.discoveryGeneration||0)+1;
    this.disposeDiscovery();this.discoveryFailed=false;
    this.reportDiscovery('starting','Looking for sharing computers…');
    const failed=error=>{
      if(this.discoveryClosed||generation!==this.discoveryGeneration)return;
      this.discoveryFailed=true;
      const code=/^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code||'')?error.code:'DISCOVERY_START_FAILED';
      this.reportDiscovery('retrying',`Nearby discovery is retrying (${code}). Refresh retries now.`,code);
    };
    try{
      this.bonjour=new Bonjour({},failed);
      this.bonjour.server.mdns.on('error',failed);
      this.bonjour.server.mdns.on('ready',()=>{if(!this.discoveryClosed&&generation===this.discoveryGeneration&&!this.discoveryFailed)this.reportDiscovery('ready','Searching automatically. Sharing computers appear here.');});
      this.browser=this.bonjour.find({type:'wavbounce'});
      for(const event of ['up','srv-update','txt-update'])this.browser.on(event,service=>{if(generation===this.discoveryGeneration&&!this.discoveryClosed)this.recordService(service);});
      this.browser.on('down',service=>{if(generation!==this.discoveryGeneration||this.discoveryClosed)return;this.discovered.delete(service.fqdn);this.emit('devices',this.devices());});
      if(this.role==='send')this.publishDiscovery();
    }catch(error){failed(error);}
  }
  disposeDiscovery(){
    try{this.service?.stop();}catch{}this.service=null;
    try{this.browser?.stop();}catch{}this.browser=null;
    try{this.bonjour?.destroy();}catch{}this.bonjour=null;
  }
  publishDiscovery(){
    if(!this.bonjour||this.discoveryFailed||this.role!=='send')return;
    try{
      this.service=this.bonjour.publish({name:`WavBounce-${this.credentials.pin.slice(0,10)}`,type:'wavbounce',port:this.port,txt:{name:this.name,pin:this.credentials.pin,v:'1',pairing:'confirm-v1'}});
      this.service.on('error',()=>{this.discoveryFailed=true;});
    }catch{this.discoveryFailed=true;}
  }
  recordService(service){
    const pin=service.txt?.pin;if(!/^[a-f0-9]{64}$/.test(pin||'')||pin===this.credentials.pin||!Number.isInteger(service.port)||service.port<1||service.port>65535)return;
    const hosts=[...new Set([service.referer?.address,...(service.addresses||[])].filter(h=>net.isIP(h)===4&&!h.startsWith('169.254.')))].slice(0,8);
    if(!hosts.length)return;
    const device={id:service.fqdn,name:cleanName(service.txt?.name||service.name),host:hosts[0],hosts,port:service.port,pin,pairable:service.txt?.pairing==='confirm-v1'};
    this.discovered.set(service.fqdn,device);this.emit('devices',this.devices());
  }
  devices(){const devices=new Map();for(const d of this.discovered.values()){if(!devices.has(d.pin)||d.id.startsWith('lan:'))devices.set(d.pin,d);}return [...devices.values()].slice(0,64);}
  refreshDevices(){if(this.discover&&!this.discoveryClosed){this.lan?.refresh();if(!this.bonjour||this.discoveryFailed)this.startDiscovery();else{this.browser?.expire();this.browser?.update();}}return this.devices();}
  requests(){return [...this.pending.values()].map(p=>({id:p.id,name:p.name,code:p.code}));}
  async share({host,port}={}){
    await this.stop();this.role='send';this.token=P.secret();
    this.server=https.createServer({key:this.credentials.key,cert:this.credentials.cert,minVersion:'TLSv1.2'},(_,res)=>{res.writeHead(404,{'Cache-Control':'no-store'});res.end();});
    this.wss=new WebSocketServer({noServer:true,maxPayload:P.MAX_MESSAGE,perMessageDeflate:false});
    this.server.on('upgrade',(req,socket,head)=>{
      if(req.url!=='/signal'||req.headers.origin||this.wss.clients.size>=12){socket.destroy();return;}
      this.wss.handleUpgrade(req,socket,head,ws=>this.accept(ws));
    });
    const listen=selected=>new Promise((resolve,reject)=>{const failed=error=>{this.server.off('listening',ready);reject(error);};const ready=()=>{this.server.off('error',failed);resolve();};this.server.once('error',failed);this.server.once('listening',ready);this.server.listen(selected,'0.0.0.0');});
    try{await listen(port??this.preferredPort??0);}catch(error){if(port===undefined&&this.preferredPort&&error.code==='EADDRINUSE'){await listen(0);this.emit('notice','The previous connection port is occupied. Choose this computer from Nearby computers or copy its new pairing link.');}else throw error;}
    this.server.on('error',error=>this.emit('notice',error.message));this.port=this.server.address().port;
    this.preferredPort=this.port;
    try{await fs.writeFile(path.join(this.directory,'listen-port.json'),JSON.stringify({port:this.port}),{mode:0o600});}catch{this.emit('notice','Sharing is on, but its connection address could not be saved for the next app restart.');}
    this.publishDiscovery();
    this.lan?.setSource({name:this.name,pin:this.credentials.pin,port:this.port});
    this.emit('status',{state:'sharing',message:'Sharing is on. Choose this computer on your listener.'});return this.links(host);
  }
  links(host){const list=addresses(),selected=list.find(i=>i.address===host)?.address||list[0]?.address||'127.0.0.1';return {link:P.makeLink({host:selected,port:this.port,token:this.token,pin:this.credentials.pin,name:this.name}),addresses:list,host:selected};}
  accept(ws){
    const id=crypto.randomUUID();let authenticated=false,offered=false,stage='hello',messages=0,challenge,name,key;
    let authTimer=setTimeout(()=>ws.close(1008,'Pairing required'),7000);
    const authorize=()=>{
      if(ws.readyState!==WebSocket.OPEN||this.role!=='send')return;
      if(!this.listenerSettings.allows(key)){ws.close(1008,'This device is not in the selected listener group.');return;}
      if(key)for(const [peerId,info]of this.peerInfo)if(info.key===key)this.disconnectListener(peerId,'Another connection from this device replaced this one.');
      if(this.peers.size>=this.entitlement.limits.listeners){ws.close(1008,this.listenerCapacityMessage());return;}
      authenticated=true;stage='ready';clearTimeout(authTimer);this.pending.delete(id);this.emit('pair-requests',this.requests());this.peers.set(id,ws);
      this.peerInfo.set(id,{id,key:key||null,name,state:'connecting'});this.emitListeners();
      ws.send(JSON.stringify({type:'welcome',v:P.VERSION,name:this.name}));this.emit('peer',{id,name,event:'joined'});
    };
    ws.on('error',()=>{});
    ws.on('message',data=>{
      try{
        if(++messages>32){ws.close(1008,'Message limit');return;}const m=P.readMessage(data);
        if(!authenticated){
          if(stage==='hello'&&m.type==='hello'&&m.v===P.VERSION){
            name=cleanName(m.name);
            if(P.equalSecret(m.token,this.token)){authorize();return;}
            if(m.method!=='device'){ws.close(1008,'Pairing link expired. Choose the sender in Nearby computers.');return;}
            P.deviceKey(m.key);key=m.key;challenge=P.secret();stage='proof';ws.send(JSON.stringify({type:'challenge',nonce:challenge}));return;
          }
          if(stage==='proof'&&m.type==='proof'&&typeof m.signature==='string'&&/^[A-Za-z0-9_-]{86}$/.test(m.signature)){
            const proof=P.deviceProof(this.credentials.pin,challenge,key,name);
            if(!crypto.verify(null,proof,P.deviceKey(key),Buffer.from(m.signature,'base64url'))){ws.close(1008,'Device identity could not be verified.');return;}
            if(this.peers.size>=this.entitlement.limits.listeners&&![...this.peerInfo.values()].some(p=>p.key===key)){ws.close(1008,this.listenerCapacityMessage());return;}
            if(Object.hasOwn(this.trusted,key)){authorize();return;}
            if(this.pending.size>=3||[...this.pending.values()].some(p=>p.key===key)){ws.close(1008,'A pairing request is already waiting.');return;}
            clearTimeout(authTimer);authTimer=setTimeout(()=>{if(this.pending.delete(id))this.emit('pair-requests',this.requests());ws.close(1008,'Pairing request expired. Try Connect again.');},this.pairingTimeout);stage='approval';
            const code=P.pairingCode(proof);this.pending.set(id,{id,name,key,code,ws,authorize});
            ws.send(JSON.stringify({type:'pairing',code,name:this.name}));this.emit('pair-requests',this.requests());return;
          }
          ws.close(1008,'Invalid pairing request.');return;
        }
        if(m.type==='offer'&&!offered&&P.validSDP(m.description,'offer')){offered=true;this.emit('offer',{id,description:m.description});}
        else if(m.type==='bye')ws.close();else ws.close(1008,'Invalid audio request');
      }catch{ws.close(1008,'Invalid request');}
    });
    ws.on('close',()=>{clearTimeout(authTimer);if(this.pending.delete(id))this.emit('pair-requests',this.requests());if(this.peers.delete(id))this.emit('peer',{id,event:'left'});this.peerInfo.delete(id);this.emitListeners();});
    ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true;});
    if(!this.heartbeat)this.heartbeat=setInterval(()=>{for(const peer of this.wss?.clients||[]){if(!peer.isAlive)peer.terminate();else{peer.isAlive=false;peer.ping();}}},15000);
  }
  async approvePair(id,allow){
    const pending=this.pending.get(id);if(!pending||this.role!=='send')throw new Error('That request has ended. Choose Connect again.');
    if(!allow){this.pending.delete(id);this.emit('pair-requests',this.requests());pending.ws.close(1008,'Pairing was declined on the sending computer.');return;}
    const gen=this.generation;this.trusted[pending.key]={name:pending.name};
    try{await this.saveTrusted();}catch(error){delete this.trusted[pending.key];throw error;}
    if(gen===this.generation&&this.pending.get(id)===pending)pending.authorize();
  }
  async saveTrusted(){const file=path.join(this.directory,'trusted-devices.json'),temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(this.trusted),{mode:0o600});await fs.rename(temporary,file);}
  listenerDevices(){
    const settings=this.listenerSettings.state,devices=[];
    for(const [key,entry]of Object.entries(this.trusted)){const live=[...this.peerInfo.values()].find(p=>p.key===key);devices.push({id:live?.id||key,key,name:settings.aliases[key]||entry.name,originalName:entry.name,state:live?.state||'offline',approved:true,allowed:this.listenerSettings.allows(key)});}
    for(const live of this.peerInfo.values())if(!live.key)devices.push({...live,approved:false,allowed:this.listenerSettings.allows(null)});
    return {devices,connected:this.peers.size,limit:this.entitlement.limits.listeners,groupsAllowed:this.entitlement.limits.groups,groups:Object.entries(settings.groups).map(([id,g])=>({id,...g})),selectedGroup:settings.selectedGroup};
  }
  emitListeners(){this.emit('listener-devices',this.listenerDevices());}
  listenerState({id,state}){const info=this.peerInfo.get(id);if(info&&['connecting','connected','disconnected','failed'].includes(state)){info.state=state;this.emitListeners();}}
  disconnectListener(id,reason='Disconnected by the sending computer. Choose Reconnect to listen again.'){
    const ws=this.peers.get(id);if(!ws)return;this.peers.delete(id);this.peerInfo.delete(id);this.emit('peer',{id,event:'left'});ws.close(1008,reason);this.emitListeners();
  }
  async renameListener(key,name){if(!Object.hasOwn(this.trusted,key))throw new Error('Choose an approved device.');await this.listenerSettings.rename(key,name);this.emitListeners();}
  async revokeListener(key){
    if(!Object.hasOwn(this.trusted,key))throw new Error('Choose an approved device.');const saved=this.trusted[key];delete this.trusted[key];
    try{await this.saveTrusted();}catch(e){this.trusted[key]=saved;throw e;}
    for(const [id,info]of this.peerInfo)if(info.key===key)this.disconnectListener(id,'Approval removed. Connect again to request approval.');
    for(const [id,request]of this.pending)if(request.key===key){this.pending.delete(id);request.ws.close(1008,'Approval removed. Connect again to request approval.');}
    try{await this.listenerSettings.forget(key);}finally{this.emitListeners();this.emit('pair-requests',this.requests());}
  }
  async saveListenerGroup(value){if(!this.entitlement.limits.groups)throw new Error('WavBounce Pro is needed to save listener groups.');const group=await this.listenerSettings.saveGroup(value,this.trusted);if(this.listenerSettings.state.selectedGroup===group.id)this.enforceListenerGroup();this.emitListeners();return group;}
  enforceListenerGroup(){for(const [id,info]of this.peerInfo)if(!this.listenerSettings.allows(info.key))this.disconnectListener(id,'This device is not in the selected listener group.');}
  async selectListenerGroup(id){await this.listenerSettings.select(id);this.enforceListenerGroup();this.emitListeners();}
  async deleteListenerGroup(id){await this.listenerSettings.removeGroup(id);this.emitListeners();}
  async forgetDevices(){const previous=this.trusted;this.trusted={};try{await this.saveTrusted();}catch(e){this.trusted=previous;throw e;}if(this.role==='send')await this.stop();await this.listenerSettings.update(s=>{s.aliases={};s.groups={};s.selectedGroup=null;});this.emitListeners();}
  answer({id,description,error}){const ws=this.peers.get(id);if(!ws||ws.readyState!==WebSocket.OPEN)return;if(error||!P.validSDP(description,'answer')){ws.close(1011,'Audio unavailable');return;}ws.send(JSON.stringify({type:'answer',description}));}
  async join(link,{recoverExpired=false}={}){const target=P.parseLink(link);await this.stop();return this.startReceiver({kind:'link',link,name:target.name},{recoverExpired});}
  async joinDevice(id){return this.joinRoute(this.routeForDevice(id));}
  routeForDevice(id){const found=this.discovered.get(id);if(!found)throw new Error('That computer is no longer visible. Start sharing there and Refresh.');if(!found.pairable)throw new Error('Update WavBounce on both computers to connect without a link.');return deviceRoute({...found,kind:'device'});}
  async joinRoute(route){if(route?.kind==='link')P.parseLink(route.link);else deviceRoute(route);await this.stop();return this.startReceiver(route);}
  startReceiver(route,options){
    this.role='receive';const receiver=new ReceiverSession(this.receiverOptions());this.receiving=receiver;
    for(const type of ['status','welcome','answer','pairing','receiver-reset'])receiver.on(type,data=>{if(this.receiving===receiver)this.emit(type,data);});
    return receiver.start(route,options);
  }
  receiverOptions(){return {name:this.name,device:this.device,devices:()=>this.devices(),refreshDevices:()=>this.refreshDevices(),pairingTimeout:this.pairingTimeout};}
  get target(){return this.receiving?.target||null;}
  get client(){return this.receiving?.client||null;}
  offer(description){this.receiving?.offer(description);}
  reconnect(){this.receiving?.reconnect();}
  connected(){this.receiving?.connected();}
  async stop(){
    this.lan?.setSource(null);
    this.generation++;this.role='idle';clearTimeout(this.timer);clearTimeout(this.phaseTimer);clearInterval(this.heartbeat);this.heartbeat=null;
    this.receiving?.stop();this.receiving=null;
    for(const [id]of this.peers)this.emit('peer',{id,event:'left'});this.peers.clear();this.peerInfo.clear();this.emitListeners();this.pending.clear();this.emit('pair-requests',[]);
    if(this.wss){for(const ws of this.wss.clients)ws.terminate();this.wss.close();this.wss=null;}
    if(this.server){const server=this.server;this.server=null;await new Promise(resolve=>server.close(resolve));}
    this.service?.stop();this.service=null;this.token=null;this.emit('status',{state:'idle',message:'Ready when you are'});
  }
  async close(){this.discoveryClosed=true;clearInterval(this.discoveryTimer);await this.stop();this.disposeDiscovery();this.lan?.close();}
}
module.exports={RelayNetwork,PinnedAgent,identity,addresses,deviceRoute};
