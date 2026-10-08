const test=require('node:test');
const assert=require('node:assert/strict');
const P=require('../shared/protocol.cjs');
test('pairing links round-trip their private capability and pinned identity',()=>{
  const route={host:'10.0.0.20',port:44444,token:P.secret(),pin:'a'.repeat(64),name:'Studio & desk'};
  assert.deepEqual(P.parseLink(P.makeLink(route)),route);
  assert.deepEqual(P.parseLink(P.makeLink(route).replace('wavbounce:','relayaudio:')),route,'the earlier Relay link format remains usable');
});
test('untrusted or incomplete pairing links are rejected',()=>{
  for(const link of ['https://example.com','wavbounce://join?v=2','wavbounce://join?v=1&host=127.0.0.1&port=22'])assert.throws(()=>P.parseLink(link));
  const good={host:'localhost',port:1234,token:P.secret(),pin:'a'.repeat(64),name:'Desk'};
  for(const bad of [{host:'a/b'},{port:70000},{token:'short'},{pin:'g'.repeat(64)}])assert.throws(()=>P.parseLink(P.makeLink({...good,...bad})));
});
test('chat formatting escapes before token underscores or hyphens do not break pairing',()=>{
  const route={host:'10.0.0.20',port:56980,token:'a'.repeat(20)+'_-'+ 'b'.repeat(21),pin:'a'.repeat(64),name:'Desk'};
  for(const count of [1,3])assert.deepEqual(P.parseLink(P.makeLink(route).replace('_-','\\'.repeat(count)+'_'+ '\\'.repeat(count)+'-')),route);
  assert.throws(()=>P.parseLink(P.makeLink({...route,token:route.token.slice(1)})),'missing capability characters are never guessed');
});
test('media negotiation only admits a single authenticated audio stream',()=>{
  const audio='v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA:BB\r\n';
  assert.equal(P.validSDP({type:'offer',sdp:audio},'offer'),true);
  for(const sdp of [audio+'m=video 9 RTP/AVP 100\r\n',audio+'m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',audio.replace('a=fingerprint:sha-256 AA:BB\r\n','')])assert.equal(P.validSDP({type:'offer',sdp},'offer'),false);
  assert.equal(P.validSDP({type:'answer',sdp:audio},'offer'),false);
});
