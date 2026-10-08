import {AudioEngine,microphones} from './audio.js';
import {ReceiverMixer} from './mixer.js';
const $=id=>document.getElementById(id);
if(!window.relay){
  const notice=document.createElement('p');notice.className='browser-notice';notice.setAttribute('role','note');
  notice.textContent='Interface preview · Open the WavBounce app to connect and stream audio.';
  document.querySelector('main').prepend(notice);
  for(const control of document.querySelectorAll('button,input,select,textarea'))control.disabled=true;
  $('computerName').textContent='This computer';$('status').textContent='Open the desktop app to start a connection.';$('stateBadge').textContent='PREVIEW';
}else{
let role='idle',stopping=false,pairing=null,saved=null,muted=false,busy=false,attempt=0,info,nearby=[],sourceLimit=1,license={pro:false,name:null,issued:null};
const sources=new Map(),sourceRows=new Map();
const mixer=new ReceiverMixer({onState:receiverState,onStats:mixStats});
const listeners=new Map();const engine=new AudioEngine({onState:audioState,onListenerState:(id,state)=>window.relay.listenerState({id,state}).catch(error)});
function error(e){$('error').textContent=(e?.message||String(e)).replace(/^Error invoking remote method '[^']+': Error: /,'');$('error').hidden=false;clearTimeout(error.timer);error.timer=setTimeout(()=>$('error').hidden=true,16000);}
function status(message,badge){$('status').textContent=message;if(badge){$('stateBadge').textContent=badge;$('stateBadge').dataset.state=badge;}}
function updateControls(){
  document.body.dataset.role=role;
  $('share').disabled=busy||stopping||role!=='idle';$('source').disabled=busy||stopping||role!=='idle';
  const full=sources.size>=sourceLimit;
  $('connect').disabled=busy||stopping||role==='send'||full;$('savedConnect').disabled=busy||stopping||role==='send'||full;
  for(const button of $('nearby').querySelectorAll('button'))button.disabled=busy||stopping||role==='send'||button.dataset.pairable!=='true'||button.dataset.connected==='true'||full;
  $('stop').disabled=stopping||role==='idle';$('stop').textContent=sources.size>1?'Stop all':'Stop';$('receiverControls').hidden=role!=='receive';$('meter').hidden=role!=='receive';
  $('listenHint').hidden=role!=='send';$('directionHint').hidden=role!=='receive';$('directionHint').textContent='Stop listening above to share this computer’s audio.';
  $('share').textContent=role==='send'?'Sharing audio':role==='receive'?'Start sharing':'Start sharing ↗';
}
async function stop(){
  stopping=true;attempt++;role='idle';pairing=null;clearTimeout(audioState.timer);listeners.clear();for(const source of sources.values())clearTimeout(source.timer);showSources({sources:[],limit:4});updateControls();
  try{await mixer.stop();await engine.stop();await window.relay.stop();$('pairing').hidden=true;$('pairing').open=false;
    $('pathSource').textContent='No active connection';$('pathOutput').textContent='';resetStats();status('Share this computer or choose a nearby device.','READY');
  }finally{stopping=false;updateControls();}
}
async function share(){
  if(busy||stopping||role!=='idle')return;busy=true;updateControls();
  try{
    await stop();const gen=attempt;role='send';updateControls();status('Opening your audio source…','STARTING');await engine.startSource($('source').value,window.relay);
    if(gen!==attempt){await engine.stop();return;}pairing=await window.relay.share({});if(gen!==attempt){await window.relay.stop();return;}
    showPair(pairing);$('pairing').hidden=false;$('source').disabled=true;$('stop').disabled=false;$('share').textContent='Sharing is on';$('pathSource').textContent=info.name;$('pathOutput').textContent='Waiting for a listener';
  }catch(e){await stop();error(e);}finally{busy=false;updateControls();}
}
function showPair(p){$('qr').src=p.qr;$('pairLink').value=p.link;$('address').replaceChildren(...p.addresses.map(a=>{const option=new Option(`${a.address} · ${a.name}`,a.address);option.selected=a.address===p.host;return option;}));}
async function beginJoin(connect){
  if(busy||stopping||role==='send')return;busy=true;const gen=attempt;updateControls();
  try{await mixer.prepare();if(gen!==attempt)return;role='receive';updateControls();await connect();}
  catch(e){if(!sources.size){role='idle';await mixer.stop();}error(e);}finally{busy=false;updateControls();}
}
async function join(link){try{await window.relay.checkLink(link);}catch(e){error(e);return;}return beginJoin(()=>window.relay.join({link,remember:$('remember').checked}));}
function joinNearby(id){return beginJoin(()=>window.relay.joinDevice({id,remember:$('remember').checked}));}
function showSaved(){$('saved').hidden=!saved;if(saved)$('savedConnect').textContent=`Reconnect to ${saved.name}`;}
function showLicense(state){
  license=state;$('proBadge').textContent=license.pro?'PRO':'FREE';$('proBadge').dataset.pro=String(license.pro);
  $('proStatus').textContent=license.pro?'Up to four listeners, four mixed sources and saved listener groups are unlocked.':'One listener and one mixed source at a time. WavBounce Pro adds up to four of each, plus saved listener groups.';
  $('proActivate').hidden=license.pro;$('proActive').hidden=!license.pro;
  if(license.pro)$('proDetail').textContent=license.name?`Licensed to ${license.name}.`:'Licensed.';
}
async function refresh(){showNearby(await window.relay.refresh());}
function showNearby(devices){
  nearby=devices;$('nearby').replaceChildren();
  if(!devices.length){const empty=document.createElement('div');empty.className='empty-state';const icon=document.createElement('span'),title=document.createElement('strong'),hint=document.createElement('p');icon.textContent='◇';icon.setAttribute('aria-hidden','true');title.textContent='No devices sharing yet';hint.textContent='Open WavBounce on another device and start sharing.';empty.append(icon,title,hint);$('nearby').append(empty);updateControls();return;}
  for(const device of devices){
    const row=document.createElement('div');row.className='device-row';
    const label=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=device.name;detail.textContent=device.pairable?'Ready to connect':'App update needed';label.append(name,detail);
    const button=document.createElement('button');button.className='secondary';button.textContent=device.pairable?'Connect':'Update needed';button.dataset.pairable=String(device.pairable);button.dataset.pin=device.pin||'';button.disabled=!device.pairable||busy||role==='send';button.setAttribute('aria-label',`Connect to ${device.name}`);button.onclick=()=>joinNearby(device.id);row.append(label,button);$('nearby').append(row);
  }
  markNearby();updateControls();
}
function showRequests(requests){
  $('pairRequests').replaceChildren();$('pairRequests').hidden=!requests.length;
  for(const request of requests){
    const row=document.createElement('div');row.className='pair-request';
    const text=document.createElement('div'),name=document.createElement('strong'),code=document.createElement('p'),help=document.createElement('p');
    name.textContent=`Allow ${request.name} to listen?`;code.className='pair-code';code.textContent=`${request.code.slice(0,3)} ${request.code.slice(3)}`;help.textContent='Only approve if this code matches the other computer. It can reconnect whenever sharing is on.';text.append(name,code,help);
    const actions=document.createElement('div');actions.className='pair-actions';
    for(const allow of [true,false]){const button=document.createElement('button');button.className=allow?'primary':'secondary';button.textContent=allow?'Allow & remember':'Decline';button.onclick=async()=>{for(const b of actions.children)b.disabled=true;try{await window.relay.approve({id:request.id,allow});}catch(e){error(e);for(const b of actions.children)b.disabled=false;}};actions.append(button);}
    row.append(text,actions);$('pairRequests').append(row);
  }
}
let listenerSnapshot={devices:[],groups:[],selectedGroup:null};
function showListeners(snapshot){
  listenerSnapshot=snapshot;$('listenerCount').textContent=`${snapshot.connected} / ${snapshot.limit} connected`;$('listenerSection').hidden=!snapshot.devices.length;
  // Keep an in-progress name edit intact when connection-state events arrive.
  if(!$('listenerDevices').contains(document.activeElement)){
    $('listenerDevices').replaceChildren();
    if(!snapshot.devices.length)$('listenerDevices').textContent='Connect a nearby device to add your first listener.';
    for(const device of snapshot.devices){
      const row=document.createElement('div');row.className='listener-card';row.dataset.deviceId=device.id;
      const title=document.createElement('strong'),detail=document.createElement('small');title.textContent=device.name;
      detail.textContent=`${device.state}${device.allowed?'':' · Outside selected group'}${device.approved?'':' · Session link'}`;const label=document.createElement('div');label.className='listener-label';label.append(title,detail);row.append(label);
      const actions=document.createElement('div');actions.className='small-actions';
      const action=(label,fn)=>{const button=document.createElement('button');button.className=label==='Revoke approval'?'text-button':'secondary';button.textContent=label;button.onclick=async()=>{button.disabled=true;try{await fn();}catch(e){error(e);}finally{button.disabled=false;showListeners(listenerSnapshot);}};actions.append(button);};
      if(device.state!=='offline')action('Disconnect',()=>window.relay.disconnectListener(device.id));
      if(device.approved){
        const edit=document.createElement('details'),summary=document.createElement('summary'),input=document.createElement('input'),save=document.createElement('button');summary.textContent='Rename';input.value=device.name;input.maxLength=40;input.setAttribute('aria-label',`Name for ${device.name}`);save.textContent='Save name';save.className='secondary';save.onclick=async()=>{try{await window.relay.renameListener({key:device.key,name:input.value});save.blur();showListeners(listenerSnapshot);}catch(e){error(e);}};edit.append(summary,input,save);row.append(edit);
        action('Revoke approval',()=>window.relay.revokeListener(device.key));
      }
      row.append(actions);$('listenerDevices').append(row);
    }
  }
  $('listenerGroup').replaceChildren(new Option('All approved devices',''),...snapshot.groups.map(g=>new Option(g.name,g.id)));$('listenerGroup').value=snapshot.selectedGroup||'';$('deleteGroup').disabled=!snapshot.selectedGroup;
  $('groupProNote').hidden=Boolean(snapshot.groupsAllowed);$('groupName').disabled=!snapshot.groupsAllowed;$('saveGroup').disabled=!snapshot.groupsAllowed;
  const checked=new Set([...$('groupMembers').querySelectorAll('input:checked')].map(i=>i.value));
  $('groupMembers').replaceChildren(...snapshot.devices.filter(d=>d.approved).map(d=>{const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=d.key;input.checked=checked.has(d.key);label.append(input,document.createTextNode(d.name));return label;}));
}
$('listenerDevices').addEventListener('focusout',()=>setTimeout(()=>{if(!$('listenerDevices').contains(document.activeElement))showListeners(listenerSnapshot);},0));
$('listenerGroup').onchange=async()=>{try{await window.relay.selectGroup($('listenerGroup').value||null);}catch(e){error(e);showListeners(listenerSnapshot);}};
$('saveGroup').onclick=async()=>{try{const keys=[...$('groupMembers').querySelectorAll('input:checked')].map(i=>i.value);await window.relay.saveGroup({name:$('groupName').value,keys});$('groupName').value='';$('groupEditor').open=false;}catch(e){error(e);}};
$('deleteGroup').onclick=async()=>{try{await window.relay.deleteGroup(listenerSnapshot.selectedGroup);}catch(e){error(e);}};
function resetStats(){for(const id of ['codec','bitrate','buffer','jitter','concealed','lost'])$(id).textContent='—';$('meterFill').style.width='0%';}
function markNearby(){
  const pins=new Set([...sources.values()].map(s=>s.pin));
  for(const button of $('nearby').querySelectorAll('button')){const connected=pins.has(button.dataset.pin);const detail=button.closest('.device-row')?.querySelector('small');if(detail)detail.textContent=connected?'Added to your mix':button.dataset.pairable==='true'?'Ready to connect':'App update needed';button.dataset.connected=String(connected);button.textContent=connected?'In your mix':button.dataset.pairable==='true'?'Connect':'Update needed';}
}
function mixSummary(){
  if(role!=='receive')return;
  const playing=[...sources.values()].filter(s=>s.state==='connected').length;
  $('pathSource').textContent=sources.size===1?[...sources.values()][0].name:`${sources.size} audio sources`;$('pathOutput').textContent=info?.name||'This computer';
  if(mixer.outputBlocked){status('Choose an available output to resume your mix.','OUTPUT NEEDED');return;}
  status(playing?`Playing ${playing} of ${sources.size} source${sources.size===1?'':'s'} · add more from Nearby devices.`:'Waiting for your audio sources…',playing?'CONNECTED':'CONNECTING');
}
function showSources(snapshot){
  if(stopping&&snapshot.sources.length)return;
  sourceLimit=snapshot.limit||1;
  const wanted=new Set(snapshot.sources.map(s=>s.id));
  for(const [id,old]of sources)if(!wanted.has(id)){clearTimeout(old.timer);sources.delete(id);mixer.remove(id);sourceRows.get(id)?.row.remove();sourceRows.delete(id);}
  for(const incoming of snapshot.sources){
    const old=sources.get(incoming.id);sources.set(incoming.id,{...old,...incoming});mixer.add(incoming.id);
    if(!sourceRows.has(incoming.id)){
      const id=incoming.id,row=document.createElement('div');row.className='source-channel';row.dataset.sourceId=id;
      const label=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('p');label.className='source-label';detail.className='helper';label.append(name,detail);
      const control=document.createElement('label'),volume=document.createElement('input'),value=document.createElement('output');control.className='channel-volume';volume.type='range';volume.min=0;volume.max=100;volume.value=100;value.textContent='100%';control.append(document.createTextNode('Volume'),value,volume);
      volume.oninput=()=>{mixer.setChannelVolume(id,Number(volume.value)/100);value.textContent=`${volume.value}%`;};
      const mute=document.createElement('button');mute.className='secondary';mute.textContent='Mute';mute.setAttribute('aria-pressed','false');mute.onclick=()=>{const c=mixer.channels.get(id);if(!c)return;mixer.setChannelMuted(id,!c.muted);mute.textContent=c.muted?'Unmute':'Mute';mute.setAttribute('aria-pressed',String(c.muted));};
      const reconnect=document.createElement('button');reconnect.className='secondary';reconnect.textContent='Reconnect';reconnect.onclick=()=>window.relay.reconnectSource(id).catch(error);
      const disconnect=document.createElement('button');disconnect.className='text-button';disconnect.textContent='Disconnect';disconnect.onclick=async()=>{disconnect.disabled=true;try{await window.relay.disconnectSource(id);}catch(e){disconnect.disabled=false;error(e);}};
      row.append(label,control,mute,reconnect,disconnect);$('sourceChannels').append(row);sourceRows.set(id,{row,name,detail,volume,mute,reconnect,disconnect});
    }
    const row=sourceRows.get(incoming.id);row.name.textContent=incoming.name;row.volume.setAttribute('aria-label',`Volume for ${incoming.name}`);row.mute.setAttribute('aria-label',`Mute ${incoming.name}`);row.disconnect.setAttribute('aria-label',`Disconnect ${incoming.name}`);
    row.detail.textContent=incoming.code?`Match ${incoming.code.slice(0,3)} ${incoming.code.slice(3)} on ${incoming.name}, then Allow & remember.`:incoming.message;row.reconnect.hidden=incoming.state!=='pairing-needed';
  }
  $('mixerSection').hidden=!sources.size;$('sourceCount').textContent=`${sources.size} / ${snapshot.limit} sources`;
  if(role!=='send')role=sources.size?'receive':'idle';
  if(!sources.size&&role==='idle'){$('pathSource').textContent='No active connection';$('pathOutput').textContent='';status('Share this computer or choose a nearby device.','READY');resetStats();}
  markNearby();updateControls();mixSummary();
}
function mixStats(){
  const values=[...mixer.channels.values()].map(c=>c.stats).filter(Boolean);if(!values.length){resetStats();return;}
  const max=key=>Math.max(...values.map(s=>s[key]||0));
  $('codec').textContent='Opus stereo';$('bitrate').textContent=`${values.reduce((sum,s)=>sum+(s.kbps||0),0).toFixed(0)} kb/s`;
  $('buffer').textContent=`${max('bufferMs').toFixed(1)} ms`;$('jitter').textContent=`${max('jitterMs').toFixed(1)} ms`;
  $('concealed').textContent=`${max('concealment').toFixed(2)}%`;$('lost').textContent=String(values.reduce((sum,s)=>sum+(s.packetsLost||0),0));
  const level=mixer.outputBlocked?0:mixer.level||0;
  $('meterFill').style.width=`${Math.min(100,Math.sqrt(level)*180)}%`;
}
function receiverState(id,state,epoch){
  const source=sources.get(id);if(!source||role!=='receive')return;
  if(state==='connected'){window.relay.connected({id,epoch}).catch(error);}
  if(state==='failed'){window.relay.retry({id,epoch}).catch(error);}
  if(state==='disconnected'){clearTimeout(source.timer);source.timer=setTimeout(()=>{if(sources.has(id)&&mixer.channels.get(id)?.engine.receiver?.connectionState==='disconnected')window.relay.retry({id,epoch}).catch(error);},5000);}
  if(state==='output-needed'){mixer.pauseOutput().catch(error);status('Choose an available output to resume your mix.','OUTPUT NEEDED');}
}
function audioState(state){if(state==='source-ended'&&role==='send')stop().then(()=>error(`${$('source').value.startsWith('mic:')?'Microphone':'System audio'} capture ended. Start sharing to open it again.`));}
const SHARE_HINTS={system:'Only your audio is shared. Your microphone stays off.',tone:'A test tone is shared. Your microphone stays off.',mic:'Your microphone is shared. Other apps on this computer can keep using it.'};
function sourceHint(){const v=$('source').value;$('shareHint').textContent=SHARE_HINTS[v.startsWith('mic:')?'mic':v]||SHARE_HINTS.system;}
async function inputs(){try{
  if(role==='send')return;const select=$('source'),selected=select.value,mics=await microphones(window.relay);
  for(const o of [...select.options])if(o.value.startsWith('mic:'))o.remove();
  select.append(new Option('Microphone · System default','mic:'),...mics.map((d,i)=>new Option(`Microphone · ${d.label||`Input ${i+1}`}`,`mic:${d.deviceId}`)));
  select.value=[...select.options].some(o=>o.value===selected)?selected:'system';sourceHint();
}catch{}}
async function outputs(){try{
  const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audiooutput'),selected=mixer.sink;
  $('output').replaceChildren(new Option('System default output',''),...devices.filter(d=>d.deviceId!=='default').map((d,i)=>new Option(d.label||`Audio output ${i+1}`,d.deviceId)));
  if(selected&&!devices.some(d=>d.deviceId===selected)){await mixer.pauseOutput();status('Selected output disconnected. Choose an output.','OUTPUT NEEDED');}else $('output').value=selected;
}catch{}}
async function sourceEvent(event){
  const {id,epoch,type,data}=event;if(stopping||!sources.has(id))return;
  if(type==='receiver-reset'){mixer.reset(id);mixStats();}
  if(type==='welcome'){
    try{const description=await mixer.createOffer(id,epoch);if(sources.has(id)&&mixer.channels.get(id)?.epoch===epoch)await window.relay.offer({id,epoch,description});}
    catch(e){if(sources.has(id)){error(e);await window.relay.retry({id,epoch});}}
  }
  if(type==='answer')await mixer.acceptAnswer(id,epoch,data.description);
}
window.relay.onEvent(async({type,data})=>{try{
  if(type==='notice')error(data);
  if(type==='status'&&role==='send'){status(data.message,data.state.toUpperCase().replaceAll('-',' '));}
  if(type==='sources')showSources(data);
  if(type==='source-event')await sourceEvent(data);
  if(type==='devices')showNearby(data);
  if(type==='discovery-status')$('discoveryStatus').textContent=data.message;
  if(type==='listener-devices')showListeners(data);
  if(type==='pair-requests')showRequests(data);
  if(type==='route-saved'){saved=data;showSaved();}
  if(type==='offer'&&role==='send'){const gen=attempt;try{const description=await engine.answer(data.id,data.description);if(gen===attempt)await window.relay.answer({id:data.id,description});}catch{await window.relay.answer({id:data.id,error:true});}}
  if(type==='peer'){
    if(data.event==='joined')listeners.set(data.id,data.name);else{listeners.delete(data.id);engine.removeSender(data.id);}
    if(role==='send'){$('pathOutput').textContent=listeners.size?`${listeners.size} paired listener${listeners.size>1?'s':''}`:'Waiting for a listener';status(listeners.size?'Audio is being shared':'Visible to nearby computers','SHARING');}
  }
}catch(e){if(role!=='idle')error(e);}});
$('share').onclick=share;$('stop').onclick=()=>stop().catch(error);$('connect').onclick=()=>join($('joinLink').value);$('refresh').onclick=()=>refresh().catch(error);
$('savedConnect').onclick=()=>beginJoin(()=>window.relay.joinSaved());
$('forget').onclick=async()=>{await window.relay.forget();saved=null;showSaved();};
$('forgetDevices').onclick=async()=>{try{await window.relay.forgetDevices();await stop();}catch(e){error(e);}};
$('activateLicense').onclick=async()=>{try{const state=await window.relay.activateLicense($('licenseKey').value);$('licenseKey').value='';showLicense(state);}catch(e){error(e);}};
$('removeLicense').onclick=async()=>{try{showLicense(await window.relay.removeLicense());}catch(e){error(e);}};
$('buyPro').onclick=async()=>{try{await window.relay.buyLicense();}catch(e){error(e);}};
$('copyLink').onclick=async()=>{if(pairing){await window.relay.copy(pairing.link);$('copyLink').textContent='Copied';setTimeout(()=>$('copyLink').textContent='Copy pairing link',1800);}};
$('address').onchange=async()=>{try{pairing=await window.relay.address($('address').value);showPair(pairing);}catch(e){error(e);}};
$('volume').oninput=()=>{const value=Number($('volume').value);mixer.setVolume(value/100);$('volumeValue').value=`${value}%`;};
$('mute').onclick=()=>{muted=!muted;mixer.setMuted(muted);$('mute').textContent=muted?'Unmute':'Mute';$('mute').setAttribute('aria-pressed',String(muted));};$('output').onchange=()=>mixer.setOutput($('output').value).then(mixSummary).catch(e=>{mixSummary();error(e);});
navigator.mediaDevices.addEventListener('devicechange',()=>{outputs();inputs();});$('source').addEventListener('change',sourceHint);document.addEventListener('visibilitychange',()=>mixer.setMonitoringEnabled(!document.hidden));
try{
  info=await window.relay.init();engine.muted=info.testing;mixer.testing=info.testing;mixer.setMonitoringEnabled(!document.hidden);$('computerName').textContent=info.name;$('platform').textContent=info.platform==='darwin'?'Mac':info.platform==='win32'?'Windows':info.platform;$('version').textContent=`WavBounce ${info.version}`;
  saved=info.saved;showSaved();showSources(info.sources||{sources:[],limit:1});showListeners(info.listeners);showNearby(info.devices||[]);$('discoveryStatus').textContent=info.discovery?.message||'';
  showLicense(info.license||{pro:false,name:null,issued:null});
  if(info.purchaseAvailable){$('buyPro').hidden=false;$('buySoon').hidden=true;}else{$('buyPro').hidden=true;$('buySoon').hidden=false;}
  await outputs();await inputs();updateControls();
  if(info.testing)window.relayTest={engine,mixer,get firstReceiver(){return mixer.channels.values().next().value?.engine;},getSources:()=>[...sources.values()],share,join,joinNearby,stop,getPairing:()=>pairing,getInfo:()=>info,getNearby:()=>nearby};
}catch(e){error(e);status('Unable to initialize WavBounce','ERROR');}
}
