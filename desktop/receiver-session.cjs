'use strict';
const {EventEmitter}=require('node:events');
const crypto=require('node:crypto');
const {WebSocket}=require('ws');
const {PinnedAgent,cleanName,deviceRoute}=require('./receiver-transport.cjs');
const P=require('../shared/protocol.cjs');

// A single authenticated source connection. No discovery sockets or disk writes.
class ReceiverSession extends EventEmitter {
  constructor({name,device,devices=()=>[],refreshDevices=()=>{},pairingTimeout=60000}) {
    super();Object.assign(this,{name,device,devices,refreshDevices,pairingTimeout});
    this.generation=0;this.epoch=0;this.retry=0;this.active=false;
  }
  start(route,{recoverExpired=true}={}) {
    const target=route?.kind==='link'?{...P.parseLink(route.link),recoverExpired}:deviceRoute(route);
    this.stop();this.target=target;this.savedRoute=route?.kind==='link'?{kind:'link',link:route.link,name:target.name}:target;
    this.active=true;this.retry=0;this.connect(this.generation);
    return {name:target.name,route:this.savedRoute};
  }
  connect(gen){
    if(gen!==this.generation||!this.active)return;
    this.epoch++;clearTimeout(this.timer);clearTimeout(this.phaseTimer);
    if(this.target.kind==='device'||this.target.recoverExpired){
      const live=this.devices().find(d=>d.pin===this.target.pin);
      if(live)Object.assign(this.target,{host:live.host,hosts:live.hosts,port:live.port,name:live.name});
    }
    const t=this.target;const hosts=t.hosts?.length?t.hosts:[t.host],host=hosts[this.retry%hosts.length];
    this.emit('status',{state:'connecting',message:`Connecting to ${t.name}…`});this.agent=new PinnedAgent(t.pin);
    const ws=new WebSocket(`wss://${host}:${t.port}/signal`,{agent:this.agent,handshakeTimeout:7000,maxPayload:P.MAX_MESSAGE,perMessageDeflate:false});this.client=ws;
    let lastError,welcomed=false;
    const current=()=>gen===this.generation&&this.client===ws&&this.active;
    ws.on('error',error=>{lastError=error;});
    ws.on('open',()=>{if(!current()){ws.close();return;}ws.send(JSON.stringify(t.kind==='device'?{type:'hello',v:P.VERSION,method:'device',key:this.device.publicKey,name:this.name}:{type:'hello',v:P.VERSION,token:t.token,name:this.name}));this.phaseTimer=setTimeout(()=>ws.terminate(),10000);});
    ws.on('message',data=>{
      if(!current())return;
      try{
        const m=P.readMessage(data);
        if(m.type==='challenge'&&t.kind==='device'&&/^[A-Za-z0-9_-]{43}$/.test(m.nonce||'')&&!welcomed){
          const proof=P.deviceProof(t.pin,m.nonce,this.device.publicKey,this.name);this.expectedCode=P.pairingCode(proof);
          ws.send(JSON.stringify({type:'proof',signature:crypto.sign(null,proof,this.device.privateKey).toString('base64url')}));
        }else if(m.type==='pairing'&&t.kind==='device'&&m.code===this.expectedCode&&!welcomed){
          clearTimeout(this.phaseTimer);this.phaseTimer=setTimeout(()=>ws.terminate(),this.pairingTimeout+5000);this.emit('pairing',{code:m.code,name:t.name});
          this.emit('status',{state:'confirming',message:`Match code ${m.code.slice(0,3)} ${m.code.slice(3)} on ${t.name}, then choose Allow & remember there.`});
        }else if(m.type==='welcome'&&m.v===P.VERSION&&!welcomed){welcomed=true;clearTimeout(this.phaseTimer);this.phaseTimer=setTimeout(()=>ws.terminate(),25000);this.emit('welcome',{name:cleanName(m.name),...(t.kind==='device'?{route:deviceRoute(t)}:{})});}
        else if(m.type==='answer'&&welcomed&&P.validSDP(m.description,'answer'))this.emit('answer',{description:m.description});
        else ws.close(1008,'Unsupported response. Update WavBounce on both computers.');
      }catch{ws.close(1008,'Invalid response');}
    });
    ws.on('close',(code,reason)=>{
      if(!current())return;clearTimeout(this.phaseTimer);this.agent?.destroy();this.emit('receiver-reset');
      if(lastError?.code==='RELAY_IDENTITY_CHANGED'){this.emit('status',{state:'pairing-needed',message:'Computer identity changed. Choose it from Nearby computers and confirm again.'});return;}
      // A saved session link may expire after Stop. Ask for normal signed-device
      // approval on the same pinned source; never retain or reuse a revoked token.
      if(code===1008&&t.recoverExpired&&/^Pairing link expired\b/.test(reason?.toString()||'')){
        this.target=deviceRoute({...t,kind:'device'});this.retry=0;this.connect(gen);return;
      }
      if(code===1008){this.emit('status',{state:'pairing-needed',message:cleanName(reason?.toString())||'Pairing ended. Choose the computer again.'});return;}
      const delay=Math.min(15000,750*2**Math.min(this.retry++,5));this.refreshDevices();
      this.emit('status',{state:'reconnecting',message:lastError?`Waiting for ${t.name}. Start sharing on that computer. If sharing is already on, choose it from Nearby computers or use its new pairing link. Retrying…`:'Connection interrupted. Reconnecting…'});
      this.timer=setTimeout(()=>this.connect(gen),delay);
    });
  }
  offer(description){if(!P.validSDP(description,'offer'))throw new Error('Invalid audio offer.');if(this.client?.readyState===WebSocket.OPEN)this.client.send(JSON.stringify({type:'offer',description}));}
  reconnect(){if(this.active)this.client?.terminate();}
  connected(){if(this.active){this.retry=0;clearTimeout(this.phaseTimer);}}
  stop(){
    this.generation++;this.active=false;clearTimeout(this.timer);clearTimeout(this.phaseTimer);
    this.client?.terminate();this.client=null;this.agent?.destroy();this.agent=null;this.target=null;
  }
}
module.exports={ReceiverSession};
