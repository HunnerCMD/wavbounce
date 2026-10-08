// Runs the debug Catalyst receiver at zero output volume. No system audio is captured.
const {_electron:electron}=require('playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const signed=process.argv.includes('--signed'),nearby=process.argv.includes('--nearby');
  const sourceName=`Native test source ${Date.now().toString(36)}`;
  const root=path.resolve(__dirname,'..');
  const dir=await fs.mkdtemp(path.join(root,'.test-data-native-'));
  let app,native;
  try {
    app=await electron.launch({args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_TEST_DISCOVERY:nearby?'1':'0',RELAY_TEST_MDNS_ONLY:'1',RELAY_TEST_NAME:sourceName,RELAY_PROFILE:path.join(dir,'sender')}});
    const page=await app.firstWindow();await page.waitForFunction(()=>window.relayTest);
    await page.evaluate(async()=>{document.getElementById('source').value='tone';await window.relayTest.share();});
    const link=new URL(await page.evaluate(()=>window.relayTest.getPairing().link));link.searchParams.set('host','127.0.0.1');
    const resultFile=path.join(dir,'native-result.json');
    const executable=path.join(root,'apple/build/catalyst/Build/Products/Debug-maccatalyst/WavBounce.app/Contents/MacOS/WavBounce');
    const route=JSON.stringify({host:'127.0.0.1',port:Number(link.searchParams.get('port')),pin:link.searchParams.get('pin'),token:'',name:sourceName});
    native=spawn(executable,[],{env:{...process.env,...(nearby?{RELAY_NATIVE_TEST_SOURCE:sourceName}:{RELAY_NATIVE_TEST_LINK:signed?route:link.toString()}),RELAY_NATIVE_TEST_RESULT:resultFile},stdio:['ignore','ignore','pipe']});
    let errors='';native.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-10000);});
    let result,approved=false;
    for(let i=0;i<90;i++){
      await new Promise(r=>setTimeout(r,500));
      if((signed||nearby)&&!approved){
        await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  try{const code=await fs.readFile(resultFile+'.code','utf8');const displayed=await page.locator('.pair-request .pair-code').textContent({timeout:500});assert.equal(displayed.replaceAll(' ',''),code);await page.getByRole('button',{name:'Allow & remember',exact:true}).click();approved=true;}catch(e){if(e.code!=='ENOENT')throw e;}
      }
      try{result=JSON.parse(await fs.readFile(resultFile,'utf8'));if(result.connected&&result.samplesEmitted>0)break;}catch{}
      if(native.exitCode!==null)throw new Error(`Native receiver exited: ${native.exitCode}. ${errors}`);
    }
    assert.ok(result?.connected,`Native receiver did not connect. ${errors}`);
    assert.ok(result.samplesEmitted>0,'native jitter buffer must emit decoded audio');
    if(signed||nearby)assert.ok(approved,'native code must match and be approved before media');
    result.signedDevicePairing=signed||nearby;result.realBonjourDiscovery=nearby;result.decodedContentVerified=false;
    result.limitation='Native receiver was muted; signaling, DTLS media receipt and jitter-buffer emission are verified, but audible content and physical output are not.';
    assert.equal(result.outputVolume,0,'native test must not play through hardware');
    await fs.writeFile(path.join(root,`evidence/native-${nearby?'nearby':signed?'signed':'audio'}-integration.json`),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally {
    if(native&&native.exitCode===null){native.kill('SIGTERM');await new Promise(r=>native.once('exit',r));}
    if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
