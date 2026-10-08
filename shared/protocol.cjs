'use strict';
const crypto = require('node:crypto');
const net = require('node:net');
const VERSION = 1;
const MAX_MESSAGE = 128 * 1024;
function secret() { return crypto.randomBytes(32).toString('base64url'); }
function fingerprint(cert) { return crypto.createHash('sha256').update(cert).digest('hex'); }
function validHost(host) {
  return typeof host === 'string' && (net.isIP(host) === 4 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host));
}
function makeLink({host, port, token, pin, name}) {
  const url = new URL('wavbounce://join');
  for (const [k,v] of Object.entries({v: VERSION,host,port,token,pin,name})) url.searchParams.set(k,String(v));
  return url.toString();
}
function parseLink(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Paste the pairing link from the sending computer.');
  let u;try { u = new URL(input.trim()); } catch { throw new Error('Paste the complete pairing link, or choose a nearby computer.'); }
  if (!['wavbounce:','relayaudio:'].includes(u.protocol) || u.hostname !== 'join' || u.searchParams.get('v') !== String(VERSION)) throw new Error('This link belongs to a different app or version. Update WavBounce on both computers, or choose a nearby computer.');
  const host=u.searchParams.get('host'), port=Number(u.searchParams.get('port'));
  // Chat editors sometimes escape base64url punctuation. Remove only those
  // formatting escapes; the complete capability still has to validate below.
  const token=u.searchParams.get('token')?.replace(/\\+([_-])/g,'$1'), pin=u.searchParams.get('pin');
  if (!validHost(host) || !Number.isInteger(port) || port<1 || port>65535 || !/^[A-Za-z0-9_-]{43}$/.test(token||'') || !/^[a-f0-9]{64}$/.test(pin||'')) throw new Error('This pairing link is incomplete. Copy it again.');
  return {host,port,token,pin,name:(u.searchParams.get('name')||'Computer').slice(0,80)};
}
function validSDP(description, type) {
  if (!description || description.type !== type || typeof description.sdp !== 'string' || description.sdp.length > 100000) return false;
  const media = description.sdp.match(/^m=\w+/gm) || [];
  return media.length===1 && media[0]==='m=audio' && /^a=fingerprint:sha-256 /mi.test(description.sdp);
}
function readMessage(data) {
  if (Buffer.byteLength(data)>MAX_MESSAGE) throw new Error('Message is too large.');
  const m=JSON.parse(data.toString());
  if (!m || typeof m!=='object' || Array.isArray(m) || typeof m.type!=='string') throw new Error('Invalid message.');
  return m;
}
function equalSecret(a,b) {
  return typeof a==='string' && typeof b==='string' && /^[A-Za-z0-9_-]{43}$/.test(a) && /^[A-Za-z0-9_-]{43}$/.test(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
function deviceProof(pin,nonce,key,name) { return Buffer.from(JSON.stringify(['WavBounce device pairing 1',pin,nonce,key,name])); }
function pairingCode(proof) { return String(crypto.createHash('sha256').update(proof).digest().readUInt32BE(0)%1000000).padStart(6,'0'); }
function deviceKey(raw) {
  if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw))throw new Error('Invalid device identity.');
  return crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(raw,'base64url')]),format:'der',type:'spki'});
}
module.exports={VERSION,MAX_MESSAGE,secret,fingerprint,makeLink,parseLink,validSDP,readMessage,equalSecret,deviceProof,pairingCode,deviceKey};
