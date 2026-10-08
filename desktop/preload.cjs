'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=(name)=>(...args)=>ipcRenderer.invoke(`relay:${name}`,...args);
contextBridge.exposeInMainWorld('relay',{
  disconnectSource:invoke('source-disconnect'),reconnectSource:invoke('source-reconnect'),checkLink:invoke('check-link'),joinDevice:invoke('join-device'),joinSaved:invoke('join-saved'),refresh:invoke('refresh'),approve:invoke('approve'),forgetDevices:invoke('forget-devices'),
  listenerState:invoke('listener-state'),disconnectListener:invoke('listener-disconnect'),renameListener:invoke('listener-rename'),revokeListener:invoke('listener-revoke'),saveGroup:invoke('group-save'),selectGroup:invoke('group-select'),deleteGroup:invoke('group-delete'),
  init:invoke('init'),armCapture:invoke('arm'),share:invoke('share'),address:invoke('address'),join:invoke('join'),offer:invoke('offer'),answer:invoke('answer'),retry:invoke('retry'),connected:invoke('connected'),stop:invoke('stop'),copy:invoke('copy'),forget:invoke('forget'),
  activateLicense:invoke('license-activate'),removeLicense:invoke('license-remove'),buyLicense:invoke('license-buy'),
  onEvent:callback=>{const listener=(_,event)=>callback(event);ipcRenderer.on('relay:event',listener);return()=>ipcRenderer.removeListener('relay:event',listener);}
});
