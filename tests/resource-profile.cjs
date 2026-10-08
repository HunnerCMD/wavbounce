// Bounded local resource measurement. Synthetic stereo only; output remains silent.
const {_electron:electron}=require('playwright');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
(async()=>{
  const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'.test-data-profile-'));const apps=[];
  await fs.mkdir(path.join(root,'evidence'),{recursive:true});
  try {
    async function launch(name){const app=await electron.launch({args:[root],env:{...process.env,RELAY_TEST:'1',RELAY_PROFILE:path.join(dir,name)}});apps.push(app);const page=await app.firstWindow();await page.waitForFunction(()=>window.relayTest);return {app,page};}
    async function sample(targets,count=8){const rows=[];for(let i=0;i<count+1;i++){await new Promise(r=>setTimeout(r,1000));const row={};for(const [name,app]of Object.entries(targets)){const metrics=await app.evaluate(({app})=>app.getAppMetrics());row[name]={cpuPercent:metrics.reduce((sum,m)=>sum+m.cpu.percentCPUUsage,0),workingSetMB:metrics.reduce((sum,m)=>sum+m.memory.workingSetSize,0)/1024};}if(i)rows.push(row);}return rows;}
    const sender=await launch('source');const idle=await sample({idle:sender.app});
    const receiver=await launch('receiver');
    await sender.page.evaluate(async()=>{document.getElementById('source').value='tone';await window.relayTest.share();});
    const link=await sender.page.evaluate(()=>window.relayTest.getPairing().link);await receiver.page.evaluate(link=>window.relayTest.join(link),link);
    await receiver.page.waitForFunction(()=>window.relayTest.firstReceiver?.audio?.srcObject);
    await receiver.page.evaluate(async()=>{window.profileContext=new AudioContext();await window.profileContext.resume();const src=window.profileContext.createMediaStreamSource(window.relayTest.firstReceiver?.audio.srcObject);const silence=window.profileContext.createGain();silence.gain.value=0;src.connect(silence).connect(window.profileContext.destination);});
    const streaming=await sample({sender:sender.app,receiver:receiver.app},10);
    function summarize(rows,key){const values=rows.map(r=>r[key]);return {meanCpuPercent:values.reduce((s,v)=>s+v.cpuPercent,0)/values.length,maxCpuPercent:Math.max(...values.map(v=>v.cpuPercent)),meanWorkingSetMB:values.reduce((s,v)=>s+v.workingSetMB,0)/values.length};}
    const result={timestamp:new Date().toISOString(),platform:process.platform,arch:process.arch,cpuModel:os.cpus()[0].model,logicalCores:os.cpus().length,idle:summarize(idle,'idle'),sending:summarize(streaming,'sender'),receiving:summarize(streaming,'receiver'),limitations:'Short local Electron development-process measurement; synthetic stereo and silent output. Working sets sum helper processes and can double-count shared pages. Not Windows CPU, battery, system-capture overhead or a long audio soak.'};
    await fs.writeFile(path.join(root,'evidence/resource-profile.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{for(const app of apps.reverse())await app.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
