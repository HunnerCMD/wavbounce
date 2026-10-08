'use strict';
// Small LAN queries with unicast replies. Only public identity is advertised;
// the existing pinned TLS + signed-device approval still authorizes audio.
const dgram=require('node:dgram'),os=require('node:os'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const PORT=47766,TAG='wavbounce-lan-1';
function ipv4(value){if(typeof value!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(value))return null;const parts=value.split('.').map(Number);if(parts.some(n=>n>255))return null;return parts.reduce((n,p)=>(n*256+p)>>>0,0);}
function privateIPv4(value){const n=ipv4(value);return n!==null&&((n>>>24)===10||(n>>>20)===0xac1||(n>>>16)===0xc0a8);}
function lanInterfaces(){
  return Object.values(os.networkInterfaces()).flat().filter(i=>i&&i.family==='IPv4'&&!i.internal&&privateIPv4(i.address)).map(i=>{
    const address=ipv4(i.address),mask=ipv4(i.netmask);if(mask===null||mask>=0xfffffffe||mask===0)return null;
    const inverse=(~mask)>>>0;if((inverse&(inverse+1))!==0)return null;
    const broadcast=((address&mask)|inverse)>>>0;
    return {address:i.address,mask,network:(address&mask)>>>0,broadcast:[24,16,8,0].map(s=>(broadcast>>>s)&255).join('.')};
  }).filter(Boolean).slice(0,8);
}
function localPeer(host,interfaces){const ip=ipv4(host);return privateIPv4(host)&&interfaces.some(i=>((ip&i.mask)>>>0)===i.network&&host!==i.broadcast&&ip!==i.network);}
function parsePacket(data){
  if(data.length>1024)return null;
  try{const m=JSON.parse(data.toString());if(m?.tag!==TAG||!['query','source','gone'].includes(m.type)||!/^[a-f0-9]{24}$/.test(m.nonce||''))return null;
    if(m.type!=='query'&&(!/^[a-f0-9]{64}$/.test(m.pin||'')||!Number.isInteger(m.port)||m.port<1||m.port>65535||typeof m.name!=='string'||m.name.length>80))return null;
    return m;
  }catch{return null;}
}
class LanDiscovery extends EventEmitter {
  constructor({interfaces=lanInterfaces,port=PORT}={}){super();this.getInterfaces=interfaces;this.port=port;this.clients=new Map();this.pending=new Map();this.peers=new Map();this.requesters=new Map();this.closed=false;this.budgetAt=0;this.budget=0;}
  start(){this.refresh();}
  fault(error){this.emit('notice',`LAN discovery is retrying (${/^[A-Z][A-Z0-9_]{1,50}$/.test(error?.code||'')?error.code:'NETWORK_ERROR'}).`);}
  send(socket,message,port,host){if(this.closed)return;const bytes=Buffer.from(JSON.stringify({tag:TAG,...message}));try{socket.send(bytes,port,host,()=>{});}catch{}}
  openServer(){
    if(this.server||this.closed)return;const socket=dgram.createSocket({type:'udp4',reuseAddr:true});this.server=socket;
    socket.on('error',error=>{if(this.server!==socket)return;this.server=null;try{socket.close();}catch{}this.fault(error);});
    socket.on('message',(data,rinfo)=>{
      if(this.closed||!this.source||this.server!==socket||!localPeer(rinfo.address,this.interfaces))return;
      const m=parsePacket(data);if(m?.type!=='query')return;
      const now=Date.now();if(now-this.budgetAt>=1000){this.budgetAt=now;this.budget=0;}if(++this.budget>20)return;
      const key=`${rinfo.address}:${rinfo.port}`;if(this.requesters.size>=64&&!this.requesters.has(key))this.requesters.delete(this.requesters.keys().next().value);
      this.requesters.set(key,{host:rinfo.address,port:rinfo.port,nonce:m.nonce,at:now});
      this.send(socket,{type:'source',nonce:m.nonce,...this.source},rinfo.port,rinfo.address);
    });
    socket.bind(this.port,'0.0.0.0');
  }
  refresh(){
    if(this.closed)return;this.interfaces=this.getInterfaces();this.openServer();const now=Date.now();
    for(const [key,value]of this.pending)if(now-value.at>45000)this.pending.delete(key);
    for(const [key,value]of this.requesters)if(now-value.at>45000)this.requesters.delete(key);
    for(const [pin,value]of this.peers)if(now-value.at>45000){this.peers.delete(pin);this.emit('down',pin);}
    const active=new Set(this.interfaces.map(i=>i.address));
    for(const [address,client]of this.clients)if(!active.has(address)){this.clients.delete(address);try{client.socket.close();}catch{}}
    for(const iface of this.interfaces){
      let client=this.clients.get(iface.address);
      if(!client){
        const socket=dgram.createSocket('udp4');client={socket,ready:false,iface,lastQuery:0};this.clients.set(iface.address,client);
        socket.on('error',error=>{if(this.clients.get(iface.address)!==client)return;this.clients.delete(iface.address);try{socket.close();}catch{}this.fault(error);});
        socket.on('message',(data,rinfo)=>this.receive(data,rinfo));
        socket.bind(0,iface.address,()=>{if(this.closed)return;socket.setBroadcast(true);client.ready=true;this.query(client);});
      }else{client.iface=iface;this.query(client);}
    }
  }
  query(client){
    if(this.closed||!client.ready||Date.now()-client.lastQuery<1000)return;client.lastQuery=Date.now();
    const nonce=crypto.randomBytes(12).toString('hex');this.pending.set(nonce,{at:Date.now()});
    while(this.pending.size>64)this.pending.delete(this.pending.keys().next().value);
    this.send(client.socket,{type:'query',nonce},this.port,client.iface.broadcast);
  }
  receive(data,rinfo){
    if(this.closed||!localPeer(rinfo.address,this.interfaces)||rinfo.port!==this.port)return;
    const m=parsePacket(data),pending=m&&this.pending.get(m.nonce);
    if(!pending||Date.now()-pending.at>45000||m.type==='query')return;
    if(m.type==='gone'){if(this.peers.get(m.pin)?.host===rinfo.address){this.peers.delete(m.pin);this.emit('down',m.pin);}return;}
    const peer={pin:m.pin,name:m.name,port:m.port,host:rinfo.address,at:Date.now()};this.peers.set(m.pin,peer);
    while(this.peers.size>64){const pin=this.peers.keys().next().value;this.peers.delete(pin);this.emit('down',pin);}
    this.emit('up',peer);
  }
  setSource(source){
    if(this.source&&!source&&this.server)for(const r of this.requesters.values())this.send(this.server,{type:'gone',nonce:r.nonce,...this.source},r.port,r.host);
    this.source=source;this.requesters.clear();
  }
  close(){this.setSource(null);this.closed=true;for(const c of this.clients.values())try{c.socket.close();}catch{}this.clients.clear();try{this.server?.close();}catch{}this.server=null;this.pending.clear();this.peers.clear();this.requesters.clear();}
}
module.exports={LanDiscovery,lanInterfaces,parsePacket,localPeer,PORT};
