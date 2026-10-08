// Real GUI, encrypted saved routes and stereo decoding; no multicast or system capture.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),directory=await fs.mkdtemp(path.join(root,'.test-data-stop-reconnect-')),apps=[];
  async function launch(profile){const app=await electron.launch({args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_TEST_NAME:profile,RELAY_PROFILE:path.join(directory,profile)}});apps.push(app);const page=await app.firstWindow();await page.waitForFunction(()=>window.relayTest);return {app,page};}
  async function sharing(source){await source.page.selectOption('#source','tone');await source.page.locator('#share').click();await source.page.waitForFunction(()=>!!window.relayTest.getPairing());}
  async function playing(receiver){await receiver.page.waitForFunction(()=>window.relayTest.firstReceiver?.receiver?.connectionState==='connected'&&window.relayTest.firstReceiver?.metrics?.receivedBytes>1000,{timeout:20000});assert.equal(await receiver.page.evaluate(()=>window.relayTest.firstReceiver?.audio.muted),true);}
  await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  try{
    let source=await launch('Source'),listener=await launch('Listener');await sharing(source);
    const link=await source.page.evaluate(()=>window.relayTest.getPairing().link);
    await listener.page.locator('#listenPanel .manual-pair summary').click();await listener.page.locator('#joinLink').fill(link);await listener.page.locator('#connect').click();await playing(listener);
    await listener.page.locator('#savedConnect').waitFor({state:'visible'});
    await listener.page.locator('#stop').click();await listener.page.locator('#savedConnect').click();await playing(listener);
    await listener.page.locator('#stop').click();await source.page.locator('#stop').click();await sharing(source);
    await listener.page.locator('#savedConnect').click();await source.page.locator('.pair-request').waitFor({state:'visible'});
    assert.equal(await source.page.locator('.pair-request .pair-code').textContent(),(await listener.page.evaluate(()=>window.relayTest.getSources()[0].code)).replace(/^(...)(...)$/,'$1 $2'));
    assert.equal(await source.page.evaluate(()=>window.relayTest.engine.senders.size),0,'no media before approval after link expiry');
    await source.page.getByRole('button',{name:'Allow & remember',exact:true}).click();await playing(listener);
    await listener.page.waitForFunction(async()=>(await window.relay.init()).saved?.kind==='device');
    const peaks=await listener.page.evaluate(async()=>{
      const context=new AudioContext({sampleRate:48000});await context.resume();const track=context.createMediaStreamSource(window.relayTest.firstReceiver?.audio.srcObject),splitter=context.createChannelSplitter(2),silent=context.createGain();silent.gain.value=0;silent.connect(context.destination);track.connect(splitter);
      const analysers=[0,1].map(i=>{const a=context.createAnalyser();a.fftSize=8192;splitter.connect(a,i);a.connect(silent);return a;});await new Promise(r=>setTimeout(r,1500));
      const values=analysers.map(a=>{const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);let best=0;for(let i=1;i<data.length;i++)if(data[i]>data[best])best=i;return best*context.sampleRate/a.fftSize;});await context.close();return values;
    });
    assert.ok(Math.abs(peaks[0]-440)<12);assert.ok(Math.abs(peaks[1]-660)<12);
    await listener.page.evaluate(()=>window.existingPC=window.relayTest.firstReceiver?.receiver);
    await listener.page.locator('#joinLink').fill('Accidental dictation is not a pairing link');await listener.page.locator('#connect').click();await listener.page.locator('#error').waitFor({state:'visible'});
    assert.equal(await listener.page.evaluate(()=>window.existingPC===window.relayTest.firstReceiver?.receiver&&window.existingPC.connectionState==='connected'),true,'invalid pasted text must not stop a working stream');
    await listener.app.close();await source.app.close();apps.length=0;
    source=await launch('Source');listener=await launch('Listener');await sharing(source);await listener.page.locator('#savedConnect').click();await playing(listener);
    assert.equal(await source.page.locator('#pairRequests').isVisible(),false,'remembered identity survives both apps restarting without discovery');
    const result={version:require('../package.json').version,timestamp:new Date().toISOString(),listenerStopReconnect:true,senderStopReconnect:true,expiredLinkRequiredCodeApproval:true,savedRouteUpgradedAfterApproval:true,bothAppsRestartedWithoutDiscovery:true,invalidTextPreservedPlayback:true,decodedStereoPeaksHz:peaks,systemAudioCaptured:false,physicalWindowsTested:false};
    await fs.writeFile(path.join(root,'evidence/stop-reconnect-audio-integration.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{for(const app of apps.reverse())await app.close().catch(()=>{});await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
