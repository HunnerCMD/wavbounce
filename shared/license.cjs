'use strict';
// Offline Ed25519 license verification. No network call, no server, constant work per key.
const crypto=require('node:crypto');
const VERSION=1;
const PRODUCT='pro';
const MAX_INPUT=4096;
// Public half of the owner's signing key (private key: ~/.wavbounce/license-signing-key.pem, outside the repo).
// Replacing this value retires every license signed with the previous key.
const PUBLIC_KEY_B64URL='9uCVmHUfqB9fTwqiZcLUmOye60iFcPKsf84FerIJ4Iw';
function publicKey(b64url){
  return crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(b64url,'base64url')]),format:'der',type:'spki'});
}
// `trusted` exists so tests can sign with a per-run key; the app always uses the embedded key.
function verify(key,trusted=PUBLIC_KEY_B64URL){
  if(typeof key!=='string'||!key.length||key.length>MAX_INPUT)return {valid:false,reason:'Malformed license key.'};
  const match=/^WB1-([A-Za-z0-9_-]{1,2800})\.([A-Za-z0-9_-]{86})$/.exec(key.trim());
  if(!match)return {valid:false,reason:'Malformed license key.'};
  const [,payloadPart,sigPart]=match;
  let payloadBytes,signature;
  try{payloadBytes=Buffer.from(payloadPart,'base64url');signature=Buffer.from(sigPart,'base64url');}
  catch{return {valid:false,reason:'Malformed license key.'};}
  if(!payloadBytes.length||payloadBytes.length>2048||signature.length!==64)return {valid:false,reason:'Malformed license key.'};
  let signatureValid;
  try{signatureValid=crypto.verify(null,payloadBytes,publicKey(trusted),signature);}
  catch{return {valid:false,reason:'Malformed license key.'};}
  if(!signatureValid)return {valid:false,reason:'This license key was altered or is not genuine.'};
  let payload;
  try{payload=JSON.parse(payloadBytes.toString('utf8'));}catch{return {valid:false,reason:'Malformed license key.'};}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return {valid:false,reason:'Malformed license key.'};
  if(payload.v!==VERSION)return {valid:false,reason:'This license key is for a different version of WavBounce.'};
  if(payload.product!==PRODUCT)return {valid:false,reason:'This license key is not for WavBounce Pro.'};
  if(typeof payload.id!=='string'||!payload.id||payload.id.length>128)return {valid:false,reason:'Malformed license key.'};
  if(payload.name!==undefined&&(typeof payload.name!=='string'||!payload.name.length||payload.name.length>80))return {valid:false,reason:'Malformed license key.'};
  if(typeof payload.issued!=='string'||payload.issued.length>40||Number.isNaN(Date.parse(payload.issued)))return {valid:false,reason:'Malformed license key.'};
  return {valid:true,payload};
}
module.exports={verify,VERSION,PRODUCT};
