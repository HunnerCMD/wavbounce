'use strict';
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {ReceiverSession}=require('./receiver-session.cjs');
const {deviceRoute}=require('./receiver-transport.cjs');
const P=require('../shared/protocol.cjs');

// One discovery service and device identity, with independent source sessions.
class ReceiverHub extends EventEmitter {
  constructor(network){super();this.network=network;this.sessions=new Map();}
  get limit(){return this.network.entitlement.limits.sources;}
  sourceCapacityMessage(){return this.limit<=1?'WavBounce Pro is needed for a second source. This connection keeps playing.':'Your mix has four sources. Disconnect one before adding another.';}
  snapshot(){return {limit:this.limit,sources:[...this.sessions.values()].map(({id,pin,name,state,message,code,session})=>({id,pin,name,state,message,code,epoch:session.epoch}))};}
  changed(){this.emit('sources',this.snapshot());}
  join(link){P.parseLink(link);return this.joinRoute({kind:'link',link});}
  joinDevice(id){return this.joinRoute(this.network.routeForDevice(id));}
  joinRoute(route){
    const target=route?.kind==='link'?P.parseLink(route.link):deviceRoute(route);
    if(this.network.role!=='idle')throw new Error('Stop sharing before adding audio sources.');
    if(target.pin===this.network.credentials.pin)throw new Error('Choose another computer to avoid an audio feedback loop.');
    const existing=[...this.sessions.values()].find(s=>s.pin===target.pin);
    if(existing){if(['pairing-needed','reconnecting'].includes(existing.state)){existing.route=route;this.reconnect(existing.id);}return {id:existing.id,name:existing.name,epoch:existing.session.epoch,route:existing.route};}
    if(this.sessions.size>=this.limit)throw new Error(this.sourceCapacityMessage());
    const id=randomUUID(),session=new ReceiverSession(this.network.receiverOptions());
    const entry={id,pin:target.pin,name:target.name,state:'connecting',message:'Connecting…',code:null,session,route};
    this.sessions.set(id,entry);
    for(const type of ['status','pairing','welcome','answer','receiver-reset'])session.on(type,data=>{
      if(this.sessions.get(id)!==entry)return;
      if(type==='status'){entry.state=data.state;entry.message=data.message;if(data.state!=='confirming')entry.code=null;}
      if(type==='pairing')entry.code=data.code;
      if(type==='welcome'){entry.code=null;entry.state='connecting';entry.message='Starting audio…';entry.route=data.route||entry.route;}
      this.emit('source-event',{id,epoch:session.epoch,type,data});this.changed();
    });
    try{const result=session.start(route);entry.route=result.route;this.changed();return {...result,id,epoch:session.epoch};}
    catch(error){this.remove(id);throw error;}
  }
  current({id,epoch}={}){const entry=this.sessions.get(id);return entry&&entry.session.epoch===epoch?entry:null;}
  offer(value){const entry=this.current(value);if(entry)entry.session.offer(value.description);}
  connected(value){const entry=this.current(value);if(entry){entry.session.connected();entry.state='connected';entry.message='Playing audio';entry.code=null;this.changed();}}
  retry(value){const entry=this.current(value);if(entry)entry.session.reconnect();}
  reconnect(id){
    const entry=this.sessions.get(id);if(!entry)return;
    this.emit('source-event',{id,epoch:entry.session.epoch,type:'receiver-reset'});
    entry.session.start(entry.route);this.changed();
  }
  remove(id){const entry=this.sessions.get(id);if(!entry)return;this.sessions.delete(id);entry.session.stop();this.changed();}
  stop(){for(const entry of this.sessions.values())entry.session.stop();this.sessions.clear();this.changed();}
}
module.exports={ReceiverHub};
