/* Native Chromium WebRTC: audio only, no cloud ICE servers, no speech processing. */
export function preferOpus(pc) {
  const opus=RTCRtpSender.getCapabilities('audio')?.codecs.filter(c=>c.mimeType.toLowerCase()==='audio/opus');
  if(opus?.length)for(const t of pc.getTransceivers())t.setCodecPreferences(opus);
}
export function stereoSDP(description) {
  const sdp=description.sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g,(line,pt,value)=>{
    if(!description.sdp.includes(`a=rtpmap:${pt} opus/48000`))return line;
    const values=value.split(';').filter(x=>!/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(x.trim()));
    return `a=fmtp:${pt} ${values.join(';')};stereo=1;sprop-stereo=1;maxaveragebitrate=256000;usedtx=0`;
  });
  return {type:description.type,sdp};
}
export async function gather(pc,timeout=10000) {
  if(pc.iceGatheringState==='complete')return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('Network candidates were not ready. Try again.'));},timeout);
    const cleanup=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);pc.removeEventListener('connectionstatechange',checkClosed);};
    const check=()=>{if(pc.iceGatheringState==='complete'){cleanup();resolve();}};
    const checkClosed=()=>{if(pc.connectionState==='closed'){cleanup();reject(new Error('Connection stopped.'));}};
    pc.addEventListener('icegatheringstatechange',check);pc.addEventListener('connectionstatechange',checkClosed);check();
  });
}
export async function testTone() {
  const ctx=new AudioContext({sampleRate:48000});
  const destination=ctx.createMediaStreamDestination();destination.channelCount=2;
  const merge=ctx.createChannelMerger(2);
  const oscillators=[440,660].map((frequency,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=frequency;g.gain.value=.07;o.connect(g).connect(merge,0,i);o.start();return o;});
  merge.connect(destination);await ctx.resume();
  return {stream:destination.stream,close:()=>{oscillators.forEach(o=>o.stop());destination.stream.getTracks().forEach(t=>t.stop());return ctx.close();}};
}
export async function captureSystem(bridge) {
  await bridge.armCapture();
  const captured=await navigator.mediaDevices.getDisplayMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:2,sampleRate:48000},video:{width:16,height:16,frameRate:1}});
  // Only audio enters a peer connection. Discard the share-picker's video immediately.
  captured.getVideoTracks().forEach(t=>t.stop());
  const tracks=captured.getAudioTracks();
  if(!tracks.length){captured.getTracks().forEach(t=>t.stop());throw new Error('The system did not provide audio. Check WavBounce’s system-audio permission.');}
  try{await tracks[0].applyConstraints({echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:2});}catch{}
  return {stream:new MediaStream(tracks),close:()=>tracks.forEach(t=>t.stop())};
}
export async function captureMicrophone(bridge,deviceId='') {
  await bridge.armCapture();
  let captured;
  try{captured=await navigator.mediaDevices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:false,noiseSuppression:false,autoGainControl:false,sampleRate:48000}});}
  catch(e){throw new Error(e?.name==='NotAllowedError'?'WavBounce needs microphone access. Allow it in System Settings → Privacy & Security → Microphone.':'That microphone is unavailable. Choose another input.');}
  const tracks=captured.getAudioTracks();
  if(!tracks.length){captured.getTracks().forEach(t=>t.stop());throw new Error('The microphone did not provide audio.');}
  // Chromium opens interfaces like a Scarlett Solo as stereo (mic on input 1, instrument on 2).
  // Send input 1 to both channels so the voice is centred for dictation on the listener.
  const ctx=new AudioContext({sampleRate:48000}),split=ctx.createChannelSplitter(2),merge=ctx.createChannelMerger(2),destination=ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(captured).connect(split);split.connect(merge,0,0);split.connect(merge,0,1);merge.connect(destination);await ctx.resume();
  const output=destination.stream.getAudioTracks()[0];
  tracks[0].addEventListener('ended',()=>output.dispatchEvent(new Event('ended')));
  return {stream:destination.stream,close:()=>{tracks.forEach(t=>t.stop());output.stop();return ctx.close();}};
}
export async function microphones(bridge) {
  // Device labels need an armed 'media' permission check in the main process.
  await bridge.armCapture();
  return (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput'&&d.deviceId!=='default'&&d.deviceId!=='communications');
}
function openSource(kind,bridge) {
  if(kind==='tone')return testTone();
  if(kind.startsWith('mic:'))return captureMicrophone(bridge,kind.slice(4));
  return captureSystem(bridge);
}
export class AudioEngine {
  constructor({onState=()=>{},onStats=()=>{},onListenerState=()=>{},onStream=null,muted=false}) {this.onStream=onStream;this.onListenerState=onListenerState;this.onState=onState;this.onStats=onStats;this.muted=muted;this.senders=new Map();this.generation=0;this.volume=.35;this.sink='';this.buffer=80;}
  async startSource(kind,bridge) {await this.stop();const gen=this.generation;const source=await openSource(kind,bridge);if(gen!==this.generation){await source.close();throw new Error('Sharing stopped.');}this.source=source;source.stream.getAudioTracks()[0].addEventListener('ended',()=>{if(this.source===source)this.onState('source-ended');});return source.stream;}
  async answer(id,description) {
    if(!this.source)throw new Error('Audio source is unavailable.');
    this.removeSender(id);const pc=new RTCPeerConnection({iceServers:[],bundlePolicy:'max-bundle'});this.senders.set(id,pc);
    pc.onconnectionstatechange=()=>{if(this.senders.get(id)===pc)this.onListenerState(id,pc.connectionState);};
    await pc.setRemoteDescription(description);
    for(const track of this.source.stream.getAudioTracks())pc.addTrack(track,this.source.stream);
    preferOpus(pc);await pc.setLocalDescription(stereoSDP(await pc.createAnswer()));await gather(pc);
    if(pc.connectionState==='closed'||this.senders.get(id)!==pc)throw new Error('Listener left.');
    const sender=pc.getSenders().find(s=>s.track?.kind==='audio');
    if(sender){const p=sender.getParameters();if(p.encodings?.length){p.encodings[0].maxBitrate=256000;await sender.setParameters(p);}}
    return {type:pc.localDescription.type,sdp:pc.localDescription.sdp};
  }
  removeSender(id){const pc=this.senders.get(id);if(pc){pc.close();this.senders.delete(id);}}
  async createOffer() {
    this.closeReceiver();const pc=new RTCPeerConnection({iceServers:[],bundlePolicy:'max-bundle'});this.receiver=pc;
    const transceiver=pc.addTransceiver('audio',{direction:'recvonly'});
    if('jitterBufferTarget' in transceiver.receiver)transceiver.receiver.jitterBufferTarget=this.buffer;
    preferOpus(pc);
    pc.onconnectionstatechange=()=>{if(this.receiver===pc)this.onState(pc.connectionState);};
    pc.ontrack=async event=>{
      if(this.receiver!==pc)return;
      if(this.onStream){
        // Chromium needs an active media renderer to drain WebRTC's jitter buffer.
        // This element is always silent; the mixer graph is the only audible path.
        const stream=event.streams[0]||new MediaStream([event.track]),driver=new Audio();
        this.audio=driver;driver.muted=true;driver.volume=0;driver.srcObject=stream;
        try{await driver.play();if(this.receiver!==pc){driver.pause();return;}await this.onStream(stream,pc);}
        catch{if(this.receiver===pc)this.onState('output-needed');}return;
      }
      const audio=new Audio();this.audio=audio;audio.autoplay=true;audio.volume=this.volume;audio.muted=this.muted;
      const stream=event.streams[0]||new MediaStream([event.track]);audio.srcObject=stream;
      try {if(this.sink)await audio.setSinkId(this.sink);await audio.play();if(this.receiver!==pc){audio.pause();return;}}
      catch {if(this.receiver===pc)this.onState('output-needed');}
      this.setMonitoringEnabled(!document.hidden);
    };
    await pc.setLocalDescription(stereoSDP(await pc.createOffer()));await gather(pc);
    if(this.receiver!==pc)throw new Error('Connection stopped.');
    return {type:pc.localDescription.type,sdp:pc.localDescription.sdp};
  }
  async acceptAnswer(description){if(this.receiver)await this.receiver.setRemoteDescription(description);}
  setMonitoringEnabled(enabled){clearInterval(this.poll);this.poll=null;this.lastStats=null;if(enabled&&this.receiver){const pc=this.receiver;this.poll=setInterval(()=>this.sample(pc).catch(()=>{}),1000);}}
  async sample(pc){
    if(this.receiver!==pc)return;
    const stats=await pc.getStats();if(this.receiver!==pc)return;
    for(const s of stats.values())if(s.type==='inbound-rtp'&&s.kind==='audio') {
      const last=this.lastStats;this.lastStats=s;
      const emitted=last?s.jitterBufferEmittedCount-last.jitterBufferEmittedCount:0;
      const samples=last?s.totalSamplesReceived-last.totalSamplesReceived:0;
      const conceal=last?s.concealedSamples-last.concealedSamples:0;
      const dt=last?(s.timestamp-last.timestamp)/1000:0;
      this.metrics={receivedBytes:s.bytesReceived,packetsReceived:s.packetsReceived,packetsLost:s.packetsLost,energy:s.totalAudioEnergy,level:s.audioLevel||0,jitterMs:(s.jitter||0)*1000,bufferMs:emitted>0?1000*(s.jitterBufferDelay-last.jitterBufferDelay)/emitted:null,concealment:samples>0?100*conceal/samples:0,kbps:dt>0?8*(s.bytesReceived-last.bytesReceived)/dt/1000:null,codec:'Opus stereo'};
      this.onStats(this.metrics);
    }
  }
  async setOutput(id){this.sink=id;if(this.audio){this.audio.pause();try{await this.audio.setSinkId(id);await this.audio.play();}catch{this.onState('output-needed');throw new Error('That output is unavailable. Choose another output.');}}}
  setVolume(value){this.volume=value;if(this.audio)this.audio.volume=value;}
  setMuted(value){this.muted=value;if(this.audio)this.audio.muted=value;}
  closeReceiver(){clearInterval(this.poll);this.poll=null;const pc=this.receiver;this.receiver=null;if(pc){pc.ontrack=null;pc.onconnectionstatechange=null;pc.close();}if(this.audio){this.audio.pause();this.audio.srcObject=null;this.audio=null;}this.lastStats=null;this.metrics=null;}
  async stop(){this.generation++;this.closeReceiver();for(const [id] of this.senders)this.removeSender(id);const source=this.source;this.source=null;if(source)await source.close();}
}
