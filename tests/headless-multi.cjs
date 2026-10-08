// One hidden browser renderer, real WebRTC and TLS signaling. No desktop app windows.
const {chromium}=require('playwright'),{RelayNetwork}=require('../desktop/network.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),QRCode=require('qrcode');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'.test-data-headless-')),clients=[];let browser,server;
 // Pro entitlement: this fixture drives four real listeners, which Free (one listener) cannot.
 const PRO={limits:{listeners:4,sources:4,groups:true}};
 const source=new RelayNetwork({directory:path.join(dir,'source'),name:'Test source',discover:false,entitlement:PRO});
 try{
  await source.init();await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  server=http.createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';if(!['index.html','app.js','audio.js','mixer.js','style.css','fonts/ibm-plex-mono-400-latin.woff2','fonts/shippori-mincho-400-latin.woff2'].includes(name)){res.writeHead(404).end();return;}try{const data=await fs.readFile(path.join(root,'desktop/ui',name));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'font/woff2');res.end(data);}catch{res.writeHead(404).end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,timeout:20000,...(process.env.WAVBOUNCE_HEADLESS_EXECUTABLE?{executablePath:process.env.WAVBOUNCE_HEADLESS_EXECUTABLE}:{}),args:['--autoplay-policy=no-user-gesture-required','--disable-audio-output']});
  const page=await browser.newPage({viewport:{width:1100,height:830}});page.setDefaultTimeout(15000);
  await page.exposeFunction('invokeRelay',async(name,value)=>{
   if(name==='init')return {name:'Test source',platform:'darwin',version:require('../package.json').version,testing:true,saved:null,devices:[],listeners:source.listenerDevices()};
   if(name==='joinDevice'){await page.evaluate(()=>window.receiveRelay({type:'sources',data:{limit:4,sources:[{id:'fixture-source',pin:'fixture-pin',name:'Office PC',state:'connecting',message:'Connecting to Office PC…',epoch:1}]}}));return {id:'fixture-source',name:'Office PC',epoch:1};}
   if(name==='stop'){await page.evaluate(()=>window.receiveRelay({type:'sources',data:{limit:4,sources:[]}}));return source.stop();}if(name==='share'){const p=await source.share();return {...p,qr:await QRCode.toDataURL(p.link)};}
   if(name==='answer')return source.answer(value);if(name==='listenerState')return source.listenerState(value);
   if(name==='approve')return source.approvePair(value.id,value.allow);if(name==='refresh')return [];
   if(name==='disconnectListener')return source.disconnectListener(value);if(name==='revokeListener')return source.revokeListener(value);
   if(name==='renameListener')return source.renameListener(value.key,value.name);if(name==='saveGroup')return source.saveListenerGroup(value);
   if(name==='selectGroup')return source.selectListenerGroup(value);if(name==='deleteGroup')return source.deleteListenerGroup(value);
   throw new Error(`Unexpected test bridge action ${name}`);
  });
  await page.addInitScript(()=>{window.testContexts=[];const OriginalAudioContext=window.AudioContext;window.AudioContext=class extends OriginalAudioContext{constructor(...args){super(...args);window.testContexts.push(this);}};const callbacks=[];window.receiveRelay=e=>callbacks.forEach(f=>f(e));window.relay={onEvent:f=>callbacks.push(f)};for(const name of ['init','stop','share','joinDevice','answer','listenerState','approve','refresh','disconnectListener','revokeListener','renameListener','saveGroup','selectGroup','deleteGroup'])window.relay[name]=v=>window.invokeRelay(name,v);});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const type of ['status','peer','offer','listener-devices','pair-requests'])source.on(type,data=>page.evaluate(e=>window.receiveRelay?.(e),{type,data}).catch(()=>{}));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.relayTest);
  assert.equal(await page.locator('#sendPanel').isVisible(),true);assert.equal(await page.locator('#listenPanel').isVisible(),true);assert.equal(await page.locator('#sendTab,#listenTab,footer').count(),0);
  await page.screenshot({path:path.join(root,'evidence/ui-unified-idle.png'),fullPage:true});
  await page.evaluate(()=>window.receiveRelay({type:'devices',data:[{id:'fixture',name:'Office PC',pairable:true,host:'192.0.2.10'}]}));
  await page.screenshot({path:path.join(root,'evidence/ui-unified-nearby.png'),fullPage:true});
  await page.getByRole('button',{name:'Connect to Office PC',exact:true}).click();assert.equal(await page.locator('#share').isDisabled(),true);assert.equal(await page.locator('#receiverControls').isVisible(),true);assert.equal(await page.locator('#stop').isEnabled(),true);
  await page.evaluate(()=>window.relayTest.share());assert.equal(source.role,'idle','sharing cannot interrupt an active receive UI');
  await page.screenshot({path:path.join(root,'evidence/ui-unified-listening.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(root,'evidence/ui-unified-small.png'),fullPage:true});await page.setViewportSize({width:1100,height:830});await page.locator('#stop').click();
  assert.equal(await page.locator('#share').isEnabled(),true);assert.equal(await page.locator('#receiverControls').isVisible(),false);
  await page.selectOption('#source','tone');await page.getByRole('button',{name:'Start sharing'}).click();await page.waitForFunction(()=>window.relayTest.getPairing());assert.equal(await page.locator('#connect').isDisabled(),true);assert.equal(await page.locator('#listenPanel').isVisible(),true);await page.evaluate(()=>window.relayTest.joinNearby('fixture'));assert.equal(source.role,'send','listen cannot interrupt sharing');
  await page.evaluate(()=>window.testReceivers=[]);
  const route={kind:'device',name:'Test source',host:'127.0.0.1',port:source.port,pin:source.credentials.pin};
  const ids=()=>[...source.peerInfo.keys()];
  async function connect(i,approve){
   if(!clients[i]){
    const client=new RelayNetwork({directory:path.join(dir,`receiver-${i}`),name:`Listener ${i+1}`,discover:false});clients[i]=client;await client.init();
    await page.evaluate(async i=>{const {AudioEngine}=await import('./audio.js');window.testReceivers[i]=new AudioEngine({muted:true});},i);
    client.on('welcome',()=>page.evaluate(i=>window.testReceivers[i].createOffer(),i).then(d=>client.offer(d)).catch(e=>errors.push(e.message)));
    client.on('answer',m=>page.evaluate(({i,d})=>window.testReceivers[i].acceptAnswer(d),{i,d:m.description}).catch(e=>errors.push(e.message)));
    client.on('receiver-reset',()=>page.evaluate(i=>window.testReceivers[i].closeReceiver(),i).catch(()=>{}));
   }
   const code=approve?new Promise(resolve=>clients[i].once('pairing',resolve)):null;await clients[i].joinRoute(route);
   if(code){const {code:expected}=await code;await page.getByRole('button',{name:'Allow & remember',exact:true}).waitFor();assert.equal((await page.locator('.pair-request .pair-code').textContent()).replaceAll(' ',''),expected);await page.getByRole('button',{name:'Allow & remember',exact:true}).click();}
   try{await page.waitForFunction(i=>window.testReceivers[i].receiver?.connectionState==='connected',i);}catch(e){console.log(JSON.stringify({errors,peers:source.peers.size,state:await page.evaluate(i=>({receiver:window.testReceivers[i].receiver?.connectionState,ice:window.testReceivers[i].receiver?.iceConnectionState,source:[...window.relayTest.engine.senders.values()].map(p=>({state:p.connectionState,ice:p.iceConnectionState})),error:document.getElementById('error').textContent}),i)}));throw e;}clients[i].connected();
  }
  async function verify(indices){return page.evaluate(async indices=>{
   const result=[];for(const i of indices){const e=window.testReceivers[i];if(e.receiver?.connectionState!=='connected')throw new Error(`Peer ${i} disconnected`);
    const c=new AudioContext({sampleRate:48000});await c.resume();const src=c.createMediaStreamSource(e.audio.srcObject),split=c.createChannelSplitter(2),silence=c.createGain();silence.gain.value=0;src.connect(split);silence.connect(c.destination);const aa=[0,1].map(j=>{const a=c.createAnalyser();a.fftSize=8192;split.connect(a,j);a.connect(silence);return a;});await new Promise(r=>setTimeout(r,2500));
    const peaks=aa.map(a=>{const d=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(d);let k=0;for(let n=1;n<d.length;n++)if(d[n]>d[k])k=n;return k*c.sampleRate/a.fftSize;});await c.close();if(Math.abs(peaks[0]-440)>12||Math.abs(peaks[1]-660)>12){const report=await e.receiver.getStats();throw new Error(JSON.stringify({peer:i,peaks,contexts:window.testContexts.map(c=>({state:c.state,time:c.currentTime})),inbound:[...report.values()].filter(x=>x.type==='inbound-rtp').map(x=>({bytes:x.bytesReceived,energy:x.totalAudioEnergy,level:x.audioLevel,emitted:x.jitterBufferEmittedCount}))}));}result.push(peaks);
   }return result;
  },indices);}
  await connect(0,true);await verify([0]);console.log('One receiver passed');await connect(1,true);await verify([0,1]);console.log('Two receivers passed');await connect(2,true);await connect(3,true);const peaks=await verify([0,1,2,3]);console.log('Four receivers passed');
  const first=page.locator('.listener-card').filter({has:page.getByText('Listener 1',{exact:true})});await first.getByRole('button',{name:'Disconnect',exact:true}).click();await page.waitForFunction(()=>!window.testReceivers[0].receiver);await verify([1,2,3]);console.log('Disconnect isolation passed');
  await connect(0,false);await first.getByRole('button',{name:'Revoke approval',exact:true}).click();await page.waitForFunction(()=>!window.testReceivers[0].receiver);await verify([1,2,3]);console.log('Revoke isolation passed');
  await page.locator('.listener-card').filter({has:page.getByText('Listener 2',{exact:true})}).getByText('Rename',{exact:true}).click();await page.getByRole('textbox',{name:'Name for Listener 2'}).fill('Desk speakers');await page.getByRole('button',{name:'Save name',exact:true}).click();await page.getByText('Desk speakers',{exact:true}).first().waitFor();
  await page.locator('#groupEditor summary').click();await page.locator('#groupName').fill('Desk');await page.locator('#groupMembers').getByText('Desk speakers',{exact:true}).click();await page.getByRole('button',{name:'Save new group',exact:true}).click();await page.locator('#listenerGroup').selectOption({label:'Desk'});await page.waitForFunction(()=>!window.testReceivers[2].receiver&&!window.testReceivers[3].receiver);await verify([1]);assert.deepEqual(errors,[]);
  await page.evaluate(()=>document.getElementById('pairing').hidden=true);await page.screenshot({path:path.join(root,'evidence/ui-unified-sharing.png'),fullPage:true});
  const result={version:require('../package.json').version,timestamp:new Date().toISOString(),browser:await browser.version(),fourIndependentPeers:true,decodedStereoPeaksHz:peaks,disconnectIsolation:true,revokeIsolation:true,approvedReconnect:true,renameAndGroupUi:true,fullDesktopAppsLaunched:0,hardwareOutput:'Chromium fake output stream',unifiedLayout:true,roleSwitchGuards:true,smallViewportNoOverflow:true,limitations:'One hidden browser renderer, real AudioEngine/WebRTC and RelayNetwork TLS/device approval, source UI through a test bridge. Does not validate Electron IPC/runtime, system capture, physical devices, resource performance, synchronized output, native iPad or long listening.'};await fs.writeFile(path.join(root,'evidence/headless-unified-ui.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{for(const c of clients)await c.close().catch(()=>{});await source.close();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
