// Two desktop test apps only. Three additional peers share the receiver renderer.
// Separate identities/signaling/decoders exercise fan-out without five full app shells.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {RelayNetwork}=require('../desktop/network.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'.test-data-multi-')),apps=[],clients=[];
 let closing=false;
 async function cleanup(){if(closing)return;closing=true;for(const client of clients)await client.close().catch(()=>{});for(const app of apps.reverse())await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,4000))]);await fs.rm(dir,{recursive:true,force:true});}
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{cleanup().finally(()=>process.exit(130));});
 const deadline=setTimeout(()=>{console.error('Multi-listener test exceeded three minutes.');cleanup().finally(()=>process.exit(1));},180000);
 await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  try{
  async function launch(name){const app=await electron.launch({timeout:20000,args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_PROFILE:path.join(dir,name),RELAY_TEST_NAME:name}});apps.push(app);const page=await app.firstWindow({timeout:20000});await page.waitForFunction(()=>window.relayTest,null,{timeout:20000});return {app,page};}
  const source=await launch('Multi source'),receiver=await launch('Listener 1');
  await source.page.selectOption('#source','tone');await source.page.getByRole('button',{name:'Start sharing'}).click();
  const u=new URL(await source.page.evaluate(()=>window.relayTest.getPairing().link));
  const route={kind:'device',host:'127.0.0.1',port:Number(u.searchParams.get('port')),pin:u.searchParams.get('pin'),name:'Multi source'};
  const encrypted=await receiver.app.evaluate(({safeStorage},route)=>safeStorage.encryptString(JSON.stringify(route)).toString('base64'),route);
  await fs.writeFile(path.join(dir,'Listener 1','route.bin'),Buffer.from(encrypted,'base64'));
  await receiver.page.evaluate(async()=>{window.testEngines=[];document.getElementById('savedConnect').click();});
  const allow=source.page.getByRole('button',{name:'Allow & remember',exact:true});await allow.waitFor();
  assert.equal(await source.page.locator('.pair-request .pair-code').textContent(),(await receiver.page.evaluate(()=>window.relayTest.getSources()[0].code)).replace(/^(...)(...)$/,'$1 $2'));await allow.click();
  await receiver.page.waitForFunction(()=>window.relayTest.firstReceiver?.receiver?.connectionState==='connected');await receiver.page.evaluate(()=>window.testEngines[0]=window.relayTest.firstReceiver);
  async function verify(indices){return receiver.page.evaluate(async indices=>{
    const results=[];
    for(const index of indices){const engine=window.testEngines[index];if(engine.receiver?.connectionState!=='connected')throw new Error(`Peer ${index} not connected`);
      const ctx=new AudioContext({sampleRate:48000});await ctx.resume();const src=ctx.createMediaStreamSource(engine.audio.srcObject),split=ctx.createChannelSplitter(2),silent=ctx.createGain();silent.gain.value=0;src.connect(split);silent.connect(ctx.destination);
      const aa=[0,1].map(i=>{const a=ctx.createAnalyser();a.fftSize=8192;split.connect(a,i);a.connect(silent);return a;});await new Promise(r=>setTimeout(r,700));
      const peaks=aa.map(a=>{const d=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(d);let k=0;for(let i=1;i<d.length;i++)if(d[i]>d[k])k=i;return k*ctx.sampleRate/a.fftSize;});await ctx.close();
      if(Math.abs(peaks[0]-440)>12||Math.abs(peaks[1]-660)>12)throw new Error(`Peer ${index} decoded peaks ${peaks}`);results.push(peaks);
    }return results;
  },indices);}
  await verify([0]);console.log('One receiver decodes stereo.');
  for(let i=1;i<4;i++){
    await receiver.page.evaluate(async i=>{const {AudioEngine}=await import('./audio.js');window.testEngines[i]=new AudioEngine({muted:true});},i);
    const client=new RelayNetwork({directory:path.join(dir,`peer-${i}`),discover:false,name:`Listener ${i+1}`});clients.push(client);await client.init();
    const errors=[];
    client.on('welcome',()=>receiver.page.evaluate(i=>window.testEngines[i].createOffer(),i).then(d=>client.offer(d)).catch(e=>errors.push(e.message)));
    client.on('answer',data=>receiver.page.evaluate(({i,d})=>window.testEngines[i].acceptAnswer(d),{i,d:data.description}).catch(e=>errors.push(e.message)));
    client.on('receiver-reset',()=>receiver.page.evaluate(i=>window.testEngines[i].closeReceiver(),i).catch(()=>{}));
    const code=new Promise(resolve=>client.once('pairing',resolve));await client.joinRoute(route);const pairing=await code;
    await allow.waitFor();assert.equal((await source.page.locator('.pair-request .pair-code').textContent()).replaceAll(' ',''),pairing.code);await allow.click();
    await receiver.page.waitForFunction(i=>window.testEngines[i].receiver?.connectionState==='connected',i);client.connected();assert.deepEqual(errors,[]);
    if(i===1){await verify([0,1]);console.log('Two receivers decode stereo.');}
  }
  const decoded=await verify([0,1,2,3]);console.log('Four receivers decode stereo.');
  const first=source.page.locator('.listener-card').filter({has:source.page.getByText('Listener 1',{exact:true})});await first.getByRole('button',{name:'Disconnect',exact:true}).click();
  await receiver.page.waitForFunction(()=>!window.testEngines[0].receiver);await verify([1,2,3]);console.log('Remaining three decode after disconnect.');
  await receiver.page.getByRole('button',{name:'Reconnect to Multi source',exact:true}).click();await receiver.page.waitForFunction(()=>window.testEngines[0].receiver?.connectionState==='connected');
  await first.getByRole('button',{name:'Revoke approval',exact:true}).click();await receiver.page.waitForFunction(()=>!window.testEngines[0].receiver);await verify([1,2,3]);
  const second=source.page.locator('.listener-card').filter({has:source.page.getByText('Listener 2',{exact:true})});await second.getByText('Rename',{exact:true}).click();await source.page.getByRole('textbox',{name:'Name for Listener 2'}).fill('Desk speakers');await source.page.getByRole('button',{name:'Save name',exact:true}).click();await source.page.getByText('Desk speakers',{exact:true}).first().waitFor();
  await source.page.locator('#groupEditor summary').click();await source.page.locator('#groupName').fill('Desk');await source.page.locator('#groupMembers').getByText('Desk speakers',{exact:true}).click();await source.page.getByRole('button',{name:'Save new group',exact:true}).click();await source.page.locator('#listenerGroup').selectOption({label:'Desk'});
  await receiver.page.waitForFunction(()=>!window.testEngines[2].receiver&&!window.testEngines[3].receiver);await verify([1]);
  await source.page.evaluate(()=>document.getElementById('pairing').hidden=true);await source.page.screenshot({path:path.join(root,'evidence/multi-listener-ui.png'),fullPage:true});
  const result={version:require('../package.json').version,timestamp:new Date().toISOString(),fullAppInstances:2,fourSimultaneousStereoReceivers:true,decodedChannelPeaksHz:decoded,disconnectIsolation:true,reconnectWithoutNewApproval:true,revokeIsolation:true,friendlyNameUi:true,groupUiIsolation:true,limitations:'Two isolated Mac desktop apps, four independent WebRTC peers sharing one receiver renderer and temporary signed identities. Muted synthetic audio only. Not four physical devices, Windows/iPad, resource benchmark, Wi-Fi outage, long soak or synchronized-speaker proof.'};await fs.writeFile(path.join(root,'evidence/multi-audio-integration.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{clearTimeout(deadline);await cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
