// Real multicast discovery and app UI pairing with isolated identities; synthetic audio only.
const {_electron:electron}=require('playwright');const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const lanOnly=process.argv.includes('--lan');
  const root=path.resolve(__dirname,'..'),directory=await fs.mkdtemp(path.join(root,'.test-data-nearby-')),apps=[];
  const suffix=Date.now().toString(36),sourceName=`WavBounce test source ${suffix}`,listenerName=`WavBounce test listener ${suffix}`;
  await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  try{
    async function launch(name,profile){const app=await electron.launch({args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_TEST_DISCOVERY:'1',RELAY_TEST_MDNS_OFF:lanOnly?'1':'0',RELAY_TEST_MDNS_ONLY:lanOnly?'0':'1',RELAY_TEST_NAME:name,RELAY_PROFILE:path.join(directory,profile)}});apps.push(app);const page=await app.firstWindow();await page.waitForFunction(()=>window.relayTest);return {app,page};}
    const source=await launch(sourceName,'source'),listener=await launch(listenerName,'listener');
    const preview=await source.app.evaluate(async({BrowserWindow},file)=>{const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});await window.loadFile(file);const state=await window.webContents.executeJavaScript(`({message:document.querySelector('.browser-notice')?.textContent,enabled:document.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)').length})`);window.destroy();return state;},path.join(root,'desktop/ui/index.html'));
    assert.match(preview.message,/preview/);assert.equal(preview.enabled,0,'browser preview cannot pretend to operate native audio');
    await source.page.selectOption('#source','tone');await source.page.getByRole('button',{name:'Start sharing'}).click();
    
    const nearby=listener.page.getByRole('button',{name:`Connect to ${sourceName}`,exact:true});await nearby.waitFor({state:'visible',timeout:20000});await nearby.click();
    const allow=source.page.getByRole('button',{name:'Allow & remember',exact:true});await allow.waitFor({state:'visible'});
    const sourceCode=await source.page.locator('.pair-request .pair-code').textContent(),listenerCode=(await listener.page.evaluate(()=>window.relayTest.getSources()[0].code)).replace(/^(...)(...)$/,'$1 $2');assert.equal(sourceCode,listenerCode);
    assert.equal(await source.page.evaluate(()=>window.relayTest.engine.senders.size),0,'no media peers before source approval');
    await source.page.screenshot({path:path.join(root,'evidence/discovery-source-0.2.0.png'),fullPage:true});await listener.page.screenshot({path:path.join(root,'evidence/discovery-listener-0.2.0.png'),fullPage:true});
    await allow.click();await listener.page.waitForFunction(()=>window.relayTest.firstReceiver?.receiver?.connectionState==='connected');
    await listener.page.waitForFunction(()=>!document.getElementById('saved').hidden);
    const samples=await listener.page.evaluate(async()=>{
      const context=new AudioContext({sampleRate:48000});await context.resume();const source=context.createMediaStreamSource(window.relayTest.firstReceiver?.audio.srcObject),splitter=context.createChannelSplitter(2),silence=context.createGain();silence.gain.value=0;source.connect(splitter);silence.connect(context.destination);
      const analysers=[0,1].map(channel=>{const a=context.createAnalyser();a.fftSize=8192;splitter.connect(a,channel);a.connect(silence);return a;});await new Promise(r=>setTimeout(r,1600));
      const peaks=analysers.map(a=>{const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);let top=0;for(let i=1;i<data.length;i++)if(data[i]>data[top])top=i;return top*context.sampleRate/a.fftSize;});await context.close();return peaks;
    });
    assert.ok(Math.abs(samples[0]-440)<12);assert.ok(Math.abs(samples[1]-660)<12);
    await listener.page.evaluate(()=>window.relayTest.stop());await source.page.evaluate(()=>window.relayTest.stop());
    await source.page.getByRole('button',{name:'Start sharing'}).click();await listener.page.getByRole('button',{name:'Refresh',exact:true}).click();
    await listener.page.getByRole('button',{name:`Reconnect to ${sourceName}`,exact:true}).click();await listener.page.waitForFunction(()=>window.relayTest.firstReceiver?.receiver?.connectionState==='connected',{timeout:20000});
    assert.equal(await source.page.locator('#pairRequests').isVisible(),false,'approved identity survives source session restart');
    const result={version:require('../package.json').version,timestamp:new Date().toISOString(),realMulticastDiscovery:!lanOnly,realLanBroadcastDiscovery:lanOnly,mdnsDisabled:lanOnly,noPairingLinkPasted:true,browserPreviewExplainedAndDisabled:true,codesMatched:true,sourceApprovalRequired:true,decodedChannelPeaksHz:samples,rememberedReconnectAfterSourceRestart:true,systemAudioCaptured:false,physicalWindowsTested:false};
    await fs.writeFile(path.join(root,`evidence/${lanOnly?'lan':'discovery'}-audio-integration.json`),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{for(const app of apps.reverse())await app.close().catch(()=>{});await fs.rm(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
