'use strict';
const {app,BrowserWindow,ipcMain,desktopCapturer,session,clipboard,powerSaveBlocker,safeStorage,shell}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const QRCode=require('qrcode');
const {RelayNetwork}=require('./network.cjs');
const {ReceiverHub}=require('./receiver-hub.cjs');
const {Entitlement}=require('./entitlement.cjs');
const {parseLink}=require('../shared/protocol.cjs');
const testing=process.env.RELAY_TEST==='1';
const PURCHASE_URL='';
if(process.env.RELAY_PROFILE)app.setPath('userData',path.resolve(process.env.RELAY_PROFILE));
app.setName('WavBounce');
let win,network,hub,entitlement,armedUntil=0,blocker,quitting=false;
const pendingSave=new Map();
let mutations=Promise.resolve();
const serialized=fn=>{const pending=mutations.then(fn);mutations=pending.catch(()=>{});return pending;};
const trusted=event=>event.sender===win?.webContents&&event.senderFrame===win.webContents.mainFrame;
function handle(name,fn,{serial=false}={}) {
  ipcMain.handle(name,(event,...args)=>{if(!trusted(event))throw new Error('Untrusted request.');return serial?serialized(()=>fn(...args)):fn(...args);});
}
app.whenReady().then(async()=>{
  entitlement=new Entitlement(app.getPath('userData'));await entitlement.load();
  network=new RelayNetwork({directory:app.getPath('userData'),entitlement,discover:!testing||process.env.RELAY_TEST_DISCOVERY==='1',mdns:!(testing&&process.env.RELAY_TEST_MDNS_OFF==='1'),lanDiscovery:!(testing&&process.env.RELAY_TEST_MDNS_ONLY==='1'),...(testing&&process.env.RELAY_TEST_NAME?{name:process.env.RELAY_TEST_NAME}:{})});
  win=new BrowserWindow({width:1100,height:830,minWidth:720,minHeight:650,backgroundColor:'#000000',title:'WavBounce',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  const send=(type,data)=>{if(!win?.isDestroyed())win.webContents.send('relay:event',{type,data});};
  hub=new ReceiverHub(network);
  entitlement.on('notice',message=>send('notice',message));
  const updatePower=()=>{
    if(network.role==='send'||hub.sessions.size){if(blocker===undefined)blocker=powerSaveBlocker.start('prevent-app-suspension');}
    else{if(blocker!==undefined)powerSaveBlocker.stop(blocker);blocker=undefined;}
  };
  for(const type of ['devices','notice','status','peer','offer','pair-requests','discovery-status','listener-devices'])network.on(type,data=>{
    if(type==='discovery-status')fs.writeFile(path.join(app.getPath('userData'),'discovery-status.json'),JSON.stringify({version:app.getVersion(),platform:process.platform,...data}),{mode:0o600}).catch(()=>{});
    if(type==='status')updatePower();send(type,data);
  });
  hub.on('sources',snapshot=>{updatePower();send('sources',snapshot);});
  hub.on('source-event',event=>{
    send('source-event',event);
    if(event.type==='welcome'&&pendingSave.has(event.id)){
      const save=pendingSave.get(event.id);pendingSave.delete(event.id);
      const route=event.data.route||save.route;
      serialized(async()=>{if(!hub.current(event))return;const persisted=await saveRoute(route);if(persisted)send('route-saved',route);}).catch(()=>send('notice','Connected, but the route could not be saved.'));
    }
  });
  const initialized=network.init();
  session.defaultSession.setPermissionCheckHandler((wc,permission)=>wc===win?.webContents&&(['speaker-selection'].includes(permission)||(['media','display-capture'].includes(permission)&&Date.now()<armedUntil)));
  session.defaultSession.setPermissionRequestHandler((wc,permission,cb)=>cb(wc===win?.webContents&&(['speaker-selection'].includes(permission)||(['media','display-capture'].includes(permission)&&Date.now()<armedUntil))));
  session.defaultSession.setDisplayMediaRequestHandler(async(request,callback)=>{
    if(request.frame!==win?.webContents.mainFrame||Date.now()>armedUntil||!request.audioRequested){callback({});return;}
    armedUntil=0;
    try {const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});if(!sources.length)throw new Error('No display available.');callback({video:sources[0],audio:'loopback'});}
    catch {callback({});}
  });
  handle('relay:init',async()=>({...await initialized,platform:process.platform,version:app.getVersion(),testing,saved:await readSaved(),devices:network.devices(),discovery:network.discoveryStatus,listeners:network.listenerDevices(),sources:hub.snapshot(),license:entitlement.state(),purchaseAvailable:Boolean(PURCHASE_URL)}));
  handle('relay:arm',()=>{armedUntil=Date.now()+10000;return true;});
  handle('relay:license-activate',async key=>{
    if(typeof key!=='string'||!key.trim()||key.length>4096)throw new Error('Paste your WavBounce Pro license key.');
    const state=await entitlement.activate(key.trim());network.emitListeners();hub.changed();return state;
  },{serial:true});
  handle('relay:license-remove',async()=>{const state=await entitlement.remove();network.emitListeners();hub.changed();return state;},{serial:true});
  handle('relay:license-buy',()=>{if(!PURCHASE_URL)return false;shell.openExternal(PURCHASE_URL);return true;});
  handle('relay:check-link',link=>{parseLink(link);return true;});
  handle('relay:share',async options=>{await initialized;if(hub.sessions.size)throw new Error('Stop listening before sharing audio.');return pairData(await network.share(options&&typeof options.host==='string'?{host:options.host}:{}));},{serial:true});
  handle('relay:address',async host=>{if(network.role!=='send')throw new Error('Start sharing first.');return pairData(network.links(host));});
  const rememberResult=(result,remember)=>{if(remember)pendingSave.set(result.id,{route:result.route});return {id:result.id,name:result.name,epoch:result.epoch};};
  handle('relay:join',async({link,remember})=>{await initialized;return rememberResult(hub.join(link),remember);},{serial:true});
  handle('relay:join-device',async({id,remember})=>{await initialized;return rememberResult(hub.joinDevice(id),remember);},{serial:true});
  handle('relay:join-saved',async()=>{await initialized;const route=await readSaved();if(!route)throw new Error('No saved route. Choose a nearby computer.');return rememberResult(hub.joinRoute(route),true);},{serial:true});
  handle('relay:source-disconnect',id=>{pendingSave.delete(id);hub.remove(id);},{serial:true});
  handle('relay:source-reconnect',id=>hub.reconnect(id),{serial:true});
  handle('relay:refresh',()=>network.refreshDevices());
  handle('relay:approve',({id,allow})=>network.approvePair(id,allow===true),{serial:true});
  handle('relay:listener-state',value=>network.listenerState(value));
  handle('relay:listener-disconnect',id=>network.disconnectListener(id),{serial:true});
  handle('relay:listener-rename',({key,name})=>network.renameListener(key,name),{serial:true});
  handle('relay:listener-revoke',key=>network.revokeListener(key),{serial:true});
  handle('relay:group-save',value=>network.saveListenerGroup(value),{serial:true});
  handle('relay:group-select',id=>network.selectListenerGroup(id),{serial:true});
  handle('relay:group-delete',id=>network.deleteListenerGroup(id),{serial:true});
  handle('relay:forget-devices',()=>network.forgetDevices(),{serial:true});
  handle('relay:offer',value=>hub.offer(value));
  handle('relay:answer',m=>network.answer(m));
  handle('relay:retry',value=>hub.retry(value));
  handle('relay:connected',value=>hub.connected(value));
  handle('relay:stop',()=>{pendingSave.clear();hub.stop();return network.stop();},{serial:true});
  handle('relay:copy',text=>{if(typeof text!=='string'||text.length>4096)throw new Error('Invalid text.');clipboard.writeText(text);});
  handle('relay:forget',()=>{pendingSave.clear();return fs.rm(path.join(app.getPath('userData'),'route.bin'),{force:true});},{serial:true});
  await win.loadFile(path.join(__dirname,'ui','index.html'));
}).catch(error=>{console.error(error);app.exit(1);});
async function pairData(value){return {...value,qr:await QRCode.toDataURL(value.link,{width:220,margin:1,errorCorrectionLevel:'M',color:{dark:'#07090b',light:'#eceef0'}})};}
async function saveRoute(route) {
  if(!safeStorage.isEncryptionAvailable())return false;
  await fs.writeFile(path.join(app.getPath('userData'),'route.bin'),safeStorage.encryptString(JSON.stringify(route)),{mode:0o600});return true;
}
async function readSaved(){
  try{
    if(!safeStorage.isEncryptionAvailable())return null;
    const raw=safeStorage.decryptString(await fs.readFile(path.join(app.getPath('userData'),'route.bin')));
    if(raw.startsWith('{')){const route=JSON.parse(raw);if(route.kind==='device')return require('./network.cjs').deviceRoute(route);if(route.kind==='link')return {kind:'link',link:route.link,name:parseLink(route.link).name};return null;}
    return {kind:'link',link:raw,name:parseLink(raw).name};
  }catch{return null;}
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;hub?.stop();network?.close().finally(()=>app.quit());});
