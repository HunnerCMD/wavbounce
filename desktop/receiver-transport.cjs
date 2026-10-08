'use strict';
const https=require('node:https'),tls=require('node:tls'),net=require('node:net');
const P=require('../shared/protocol.cjs');

class PinnedAgent extends https.Agent {
  constructor(pin){super({keepAlive:false});this.pin=pin;}
  createConnection(options,callback){
    let done=false;
    const finish=(error,socket)=>{if(!done){done=true;callback(error,socket);}};
    const socket=tls.connect({...options,rejectUnauthorized:false},()=>{
      const raw=socket.getPeerCertificate().raw;
      if(!raw||P.fingerprint(raw)!==this.pin){const error=new Error('The sending computer identity changed. Choose it in Nearby computers and confirm again.');error.code='RELAY_IDENTITY_CHANGED';finish(error);socket.destroy();return;}
      socket.setTimeout(0);finish(null,socket);
    });
    socket.setTimeout(7000,()=>socket.destroy(Object.assign(new Error('Connection timed out.'),{code:'ETIMEDOUT'})));
    socket.once('error',error=>finish(error));
    // Never send the HTTP/WebSocket handshake before the exact certificate pin matches.
    return undefined;
  }
}
function cleanName(name){return typeof name==='string'?name.slice(0,80):'Computer';}
function deviceRoute(value){
  if(!value||value.kind!=='device'||!/^[a-f0-9]{64}$/.test(value.pin||'')||!Number.isInteger(value.port)||value.port<1||value.port>65535||net.isIP(value.host)!==4)throw new Error('Choose the computer again from Nearby computers.');
  return {kind:'device',pin:value.pin,host:value.host,hosts:[...new Set([value.host,...(Array.isArray(value.hosts)?value.hosts:[])].filter(h=>net.isIP(h)===4))].slice(0,8),port:value.port,name:cleanName(value.name)};
}

module.exports={PinnedAgent,cleanName,deviceRoute};
