// Programmatic application integration test; no user-system audio is captured.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..');const dir=await fs.mkdtemp(path.join(root,'.test-data-'));const apps=[];
  try {
    async function launch(name){const app=await electron.launch({args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_PROFILE:path.join(dir,name)}});apps.push(app);const page=await app.firstWindow();await page.waitForFunction(()=>window.relayTest,{timeout:30000});return page;}
    const sender=await launch('sender'),receiver=await launch('receiver');
    await sender.evaluate(async()=>{document.getElementById('source').value='tone';await window.relayTest.share();});
    const link=await sender.evaluate(()=>window.relayTest.getPairing()?.link);assert.ok(link,'source must produce pairing link');
    await receiver.evaluate(link=>window.relayTest.join(link),link);
    await receiver.waitForFunction(()=>window.relayTest.firstReceiver?.metrics?.receivedBytes>10000,{timeout:30000});
    const first=await receiver.evaluate(()=>window.relayTest.firstReceiver?.metrics);
    assert.equal(await receiver.evaluate(()=>window.relayTest.firstReceiver?.audio.muted),true,'integration audio must be muted');
    // Inspect decoded stereo independently: dominant FFT bins on the received track.
    const spectrum=await receiver.evaluate(async()=>{
      const ctx=new AudioContext({sampleRate:48000});await ctx.resume();const source=ctx.createMediaStreamSource(window.relayTest.firstReceiver?.audio.srcObject);const splitter=ctx.createChannelSplitter(2);source.connect(splitter);
      const silence=ctx.createGain();silence.gain.value=0;silence.connect(ctx.destination);
      const analysers=[0,1].map(i=>{const a=ctx.createAnalyser();a.fftSize=8192;splitter.connect(a,i);a.connect(silence);return a;});
      await new Promise(r=>setTimeout(r,1800));const peaks=analysers.map(a=>{const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);let best=0;for(let i=1;i<data.length;i++)if(data[i]>data[best])best=i;return best*ctx.sampleRate/a.fftSize;});await ctx.close();return peaks;
    });
    assert.ok(Math.abs(spectrum[0]-440)<12,`left channel peak ${spectrum[0]}`);assert.ok(Math.abs(spectrum[1]-660)<12,`right channel peak ${spectrum[1]}`);
    // Source is silent to hardware; receive pipeline must survive a signaling reconnect.
    await receiver.evaluate(()=>{window.beforeReconnectPC=window.relayTest.firstReceiver?.receiver;return window.relay.retry(window.relayTest.getSources()[0]);});
    await receiver.waitForFunction(()=>window.relayTest.firstReceiver?.receiver!==window.beforeReconnectPC&&window.relayTest.firstReceiver?.receiver?.connectionState==='connected'&&window.relayTest.firstReceiver?.metrics?.receivedBytes>1000,{timeout:30000});
    const result={test:'desktop-to-desktop synthetic stereo',timestamp:new Date().toISOString(),decodedChannelPeaksHz:spectrum,firstStats:first,reconnected:true,systemAudioCaptured:false,physicalOutputAudited:false};
    await fs.mkdir(path.join(root,'evidence'),{recursive:true});await fs.writeFile(path.join(root,'evidence','desktop-audio-integration.json'),JSON.stringify(result,null,2));
    await receiver.evaluate(()=>window.relayTest.stop());assert.equal(await receiver.evaluate(()=>window.relayTest.firstReceiver?.receiver),undefined);
    console.log(JSON.stringify(result,null,2));
  }finally{for(const app of apps.reverse())await app.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
