'use strict';
// Three real source connections mixed by the actual desktop UI in one hidden browser.
const {chromium}=require('playwright');
const {RelayNetwork}=require('../desktop/network.cjs');
const {ReceiverHub}=require('../desktop/receiver-hub.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await pause(20);}throw new Error('Timed out waiting for signaling');}
(async()=>{
  const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'.test-data-mixer-ui-'));
  const nodes=[],errors=[];let browser,server,hub;
  // Pro entitlement: this fixture mixes three real sources, which Free (one source) cannot.
  const PRO={limits:{listeners:4,sources:4,groups:true}};
  try{
    const make=async(name,options={})=>{const n=new RelayNetwork({directory:path.join(dir,name),name,discover:false,...options});nodes.push(n);await n.init();return n;};
    const local=await make('Receiving Mac',{entitlement:PRO}),sources=[];
    for(const name of ['Windows PC','MacBook','Studio source']){const source=await make(name);await source.share({host:'127.0.0.1'});sources.push(source);}
    const devices=sources.map((s,i)=>({id:`source-${i}`,name:s.name,pin:s.credentials.pin,host:'127.0.0.1',port:s.port,pairable:true}));
    for(const d of devices)local.discovered.set(d.id,d);hub=new ReceiverHub(local);
    server=http.createServer(async(req,res)=>{
      const name=new URL(req.url,'http://localhost').pathname.slice(1)||'index.html';
      if(!['index.html','app.js','audio.js','mixer.js','style.css','fonts/ibm-plex-mono-400-latin.woff2','fonts/ibm-plex-mono-600-latin.woff2','fonts/shippori-mincho-400-latin.woff2'].includes(name)){res.writeHead(404).end();return;}
      try{const data=await fs.readFile(path.join(root,'desktop/ui',name));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'font/woff2');res.end(data);}catch{res.writeHead(404).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,timeout:20000,...(process.env.WAVBOUNCE_HEADLESS_EXECUTABLE?{executablePath:process.env.WAVBOUNCE_HEADLESS_EXECUTABLE}:{}),args:['--autoplay-policy=no-user-gesture-required','--disable-audio-output']});
    const page=await browser.newPage({viewport:{width:1100,height:900}});page.setDefaultTimeout(18000);page.on('pageerror',e=>errors.push(e.message));
    const emit=(type,data)=>page.evaluate(event=>window.receiveRelay?.(event),{type,data}).catch(e=>errors.push(e.message));
    hub.on('sources',s=>emit('sources',s));hub.on('source-event',e=>emit('source-event',e));
    await page.exposeFunction('invokeRelay',async(name,value)=>{
      if(name==='init')return {name:local.name,platform:'darwin',version:require('../package.json').version,testing:true,saved:null,devices,listeners:local.listenerDevices(),sources:hub.snapshot()};
      if(name==='refresh')return devices;if(name==='joinDevice')return hub.joinDevice(value.id);if(name==='join')return hub.join(value.link);
      if(name==='checkLink'){require('../shared/protocol.cjs').parseLink(value);return true;}
      if(name==='offer')return hub.offer(value);if(name==='connected')return hub.connected(value);if(name==='retry')return hub.retry(value);
      if(name==='disconnectSource')return hub.remove(value);if(name==='reconnectSource')return hub.reconnect(value);
      if(name==='stop'){hub.stop();return local.stop();}
      if(name==='share'){if(hub.sessions.size)throw new Error('Stop listening before sharing audio.');return local.share();}
      throw new Error(`Unexpected bridge action ${name}`);
    });
    await page.addInitScript(()=>{const callbacks=[];window.receiveRelay=e=>callbacks.forEach(f=>f(e));window.relay={onEvent:f=>callbacks.push(f)};for(const name of ['init','refresh','joinDevice','join','checkLink','offer','connected','retry','disconnectSource','reconnectSource','stop','share'])window.relay[name]=value=>window.invokeRelay(name,value);});
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.relayTest);
    await page.evaluate(async()=>{
      const {AudioEngine}=await import('./audio.js');const ctx=new AudioContext({sampleRate:48000});await ctx.resume();window.fixtureContext=ctx;
      window.fixtureSources=[[330,550],[440,660],[880,1100]].map(frequencies=>{
        const destination=ctx.createMediaStreamDestination(),merge=ctx.createChannelMerger(2);destination.channelCount=2;
        const oscillators=frequencies.map((f,i)=>{const o=ctx.createOscillator(),gain=ctx.createGain();o.frequency.value=f;gain.gain.value=.15;o.connect(gain).connect(merge,0,i);o.start();return o;});merge.connect(destination);
        const engine=new AudioEngine({muted:true});engine.source={stream:destination.stream,close:()=>{oscillators.forEach(o=>o.stop());destination.stream.getTracks().forEach(t=>t.stop());}};return engine;
      });
    });
    sources.forEach((source,i)=>{
      source.on('offer',m=>page.evaluate(({i,m})=>window.fixtureSources[i].answer(m.id,m.description),{i,m}).then(description=>source.answer({id:m.id,description})).catch(e=>errors.push(e.message)));
      source.on('peer',m=>{if(m.event==='left')page.evaluate(({i,id})=>window.fixtureSources[i].removeSender(id),{i,id:m.id}).catch(()=>{});});
    });
    async function connect(i){
      await page.getByRole('button',{name:`Connect to ${sources[i].name}`,exact:true}).click();
      await until(()=>sources[i].requests().length>0);const request=sources[i].requests()[0];
      await page.getByText(`Match ${request.code.slice(0,3)} ${request.code.slice(3)} on ${sources[i].name}, then Allow & remember.`,{exact:true}).waitFor();
      assert.equal(sources[i].peers.size,0);await sources[i].approvePair(request.id,true);
      await page.waitForFunction(name=>window.relayTest.getSources().some(s=>s.name===name&&s.state==='connected'),sources[i].name);
    }
    await connect(0);
    await connect(1);await connect(2);await pause(1800);
    await page.waitForFunction(()=>window.relayTest.mixer.level>0.0001);
    assert.equal(await page.locator('.source-channel').count(),3);assert.equal(await page.locator('#share').isDisabled(),true);
    await page.evaluate(()=>window.relayTest.share());assert.equal(local.role,'idle');
    await page.evaluate(()=>{
      const m=window.relayTest.mixer,c=m.context,split=c.createChannelSplitter(2),silent=c.createGain();silent.gain.value=0;m.master.connect(split);silent.connect(c.destination);
      window.mixAnalysers=[0,1].map(i=>{const a=c.createAnalyser();a.fftSize=16384;a.smoothingTimeConstant=0;split.connect(a,i);a.connect(silent);return a;});
    });
    async function spectrum(){await pause(650);return page.evaluate(()=>window.mixAnalysers.map((a,i)=>{const data=new Float32Array(a.frequencyBinCount);a.getFloatFrequencyData(data);return (i===0?[330,440,880]:[550,660,1100]).map(f=>{const bin=Math.round(f*a.fftSize/window.relayTest.mixer.context.sampleRate);return Math.max(...data.slice(bin-2,bin+3));});}));}
    let mixed=await spectrum();for(let retry=0;retry<3&&mixed.flat().some(v=>v<=-55);retry++)mixed=await spectrum();for(const channel of mixed)for(const level of channel)assert.ok(level>-55,`Missing mixed source: ${level}dB`);
    assert.equal(await page.evaluate(()=>window.relayTest.mixer.output.gain.value),0,'The test output remains inaudible');
    await page.getByRole('button',{name:'Mute MacBook',exact:true}).click();const muted=await spectrum();
    for(let c=0;c<2;c++){assert.ok(muted[c][1]<mixed[c][1]-30,'Only the selected input should be muted');assert.ok(Math.abs(muted[c][0]-mixed[c][0])<3);assert.ok(Math.abs(muted[c][2]-mixed[c][2])<3);}
    await page.getByRole('button',{name:'Mute MacBook',exact:true}).click();
    await page.getByRole('slider',{name:'Volume for Windows PC',exact:true}).fill('50');const adjusted=await spectrum();for(let c=0;c<2;c++)assert.ok(adjusted[c][0]<mixed[c][0]-3,'Source volume reduces its contribution');
    await page.getByRole('slider',{name:'Volume for Windows PC',exact:true}).fill('100');
    const first=hub.snapshot().sources.find(s=>s.name==='Windows PC'),epoch=first.epoch;hub.retry(first);
    await until(()=>hub.sessions.get(first.id).session.epoch>epoch);await page.waitForFunction(()=>window.relayTest.getSources().every(s=>s.state==='connected'));const recovered=await spectrum();for(const channel of recovered)for(const level of channel)assert.ok(level>-55);
    await page.screenshot({path:path.join(root,'evidence/ui-mixer-three-sources.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(root,'evidence/ui-mixer-small.png'),fullPage:true});await page.setViewportSize({width:1100,height:900});
    await page.getByRole('button',{name:'Disconnect MacBook',exact:true}).click();await page.waitForFunction(()=>window.relayTest.getSources().length===2);const isolated=await spectrum();
    for(let c=0;c<2;c++){assert.ok(isolated[c][1]<-70);assert.ok(isolated[c][0]>-55);assert.ok(isolated[c][2]>-55);}
    // Invalid input is rejected before changing any live connections.
    await page.evaluate(()=>window.relayTest.join('not a pairing link'));assert.equal(hub.sessions.size,2);
    await page.locator('#mute').click();const masterMuted=await spectrum();for(const channel of masterMuted)for(const level of channel)assert.ok(level<-90);await page.locator('#mute').click();
    // Losing a selected output must pause all streams without falling back to speakers.
    await page.evaluate(()=>window.relayTest.mixer.setOutput('not-an-output').catch(()=>{}));
    assert.equal(await page.evaluate(()=>window.relayTest.mixer.outputBlocked),true);assert.equal(await page.evaluate(()=>window.relayTest.mixer.context.state),'suspended');
    await page.evaluate(()=>window.relayTest.mixer.setOutput(''));assert.equal(await page.evaluate(()=>window.relayTest.mixer.context.state),'running');
    await page.evaluate(()=>window.relayTest.mixer.setMonitoringEnabled(false));assert.equal(await page.evaluate(()=>window.relayTest.mixer.poll),null);await page.evaluate(()=>window.relayTest.mixer.setMonitoringEnabled(true));
    await page.evaluate(()=>{window.stoppedMixerContext=window.relayTest.mixer.context;return true;});
    await page.locator('#stop').click();await page.waitForFunction(()=>!window.relayTest.mixer.context);assert.equal(hub.sessions.size,0);assert.equal(await page.locator('.source-channel').count(),0);assert.equal(await page.evaluate(()=>window.stoppedMixerContext.state),'closed');assert.equal(await page.locator('#share').isEnabled(),true);
    assert.deepEqual(errors,[]);
    const result={version:require('../package.json').version,timestamp:new Date().toISOString(),browser:await browser.version(),threeConcurrentSources:true,mixedStereoFrequencyLevelsDb:mixed,perSourceMuteAndVolume:true,masterMute:true,reconnectIsolation:true,disconnectIsolation:true,invalidInputPreservesMix:true,outputLossPausesMix:true,hiddenMonitoringStops:true,stopClosesAll:true,smallViewportNoOverflow:true,fullDesktopAppsLaunched:0,hardwareOutput:'Chromium fake output stream',limitations:'One hidden Chromium browser; real TLS/code approval, ReceiverHub, desktop UI, WebRTC stereo and Web Audio mixing through a test bridge. No production Electron IPC, physical Windows/Mac/iPad, system capture, long listening or CPU/battery acceptance.'};
    await fs.writeFile(path.join(root,'evidence/headless-mixer.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{hub?.stop();for(const n of nodes)await n.close();await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
