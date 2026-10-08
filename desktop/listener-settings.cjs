'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const validKey=key=>typeof key==='string'&&/^[A-Za-z0-9_-]{43}$/.test(key);
const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>40)throw new Error('Use a name between 1 and 40 characters.');return value.trim();};
class ListenerSettings {
  constructor(directory){this.file=path.join(directory,'listener-settings.json');this.state={version:1,aliases:{},groups:{},selectedGroup:null};this.writes=Promise.resolve();}
  async load(){try{const s=JSON.parse(await fs.readFile(this.file,'utf8'));if(s.version!==1||!s.aliases||typeof s.aliases!=='object'||Array.isArray(s.aliases)||!s.groups||typeof s.groups!=='object'||Array.isArray(s.groups)||Object.keys(s.groups).length>12)throw new Error();for(const [key,value]of Object.entries(s.aliases)){if(!validKey(key))throw new Error();name(value);}for(const [id,g]of Object.entries(s.groups)){if(!/^[a-f0-9-]{36}$/.test(id)||!Array.isArray(g.keys)||g.keys.length>4||!g.keys.every(validKey))throw new Error();name(g.name);}if(s.selectedGroup!==null&&!Object.hasOwn(s.groups,s.selectedGroup))throw new Error();this.state=s;}catch(e){if(e.code!=='ENOENT')throw new Error('Saved listener settings could not be read. Restore that file before sharing.');}}
  update(change){const work=this.writes.then(async()=>{const state=structuredClone(this.state),result=change(state);const temporary=this.file+'.tmp';await fs.writeFile(temporary,JSON.stringify(state),{mode:0o600});await fs.rename(temporary,this.file);this.state=state;return result;});this.writes=work.catch(()=>{});return work;}
  rename(key,value){if(!validKey(key))throw new Error('Choose an approved device.');const label=name(value);return this.update(s=>{s.aliases[key]=label;});}
  saveGroup({id,name:label,keys},approved){label=name(label);if(!Array.isArray(keys)||!keys.length||keys.length>4||!keys.every(k=>validKey(k)&&Object.hasOwn(approved,k)))throw new Error('Choose between one and four approved devices.');if(id!==undefined&&!Object.hasOwn(this.state.groups,id))throw new Error('That group no longer exists.');return this.update(s=>{if(id!==undefined&&!Object.hasOwn(s.groups,id))throw new Error('That group no longer exists.');if(!id&&Object.keys(s.groups).length>=12)throw new Error('You can save up to twelve groups.');id=id||crypto.randomUUID();s.groups[id]={name:label,keys:[...new Set(keys)]};return {id,...s.groups[id]};});}
  select(id){return this.update(s=>{if(id!==null&&!Object.hasOwn(s.groups,id))throw new Error('Choose an existing listener group.');s.selectedGroup=id;});}
  removeGroup(id){return this.update(s=>{delete s.groups[id];if(s.selectedGroup===id)s.selectedGroup=null;});}
  forget(key){return this.update(s=>{delete s.aliases[key];for(const g of Object.values(s.groups))g.keys=g.keys.filter(k=>k!==key);});}
  allows(key){const s=this.state;return s.selectedGroup===null||Boolean(key&&s.groups[s.selectedGroup]?.keys.includes(key));}
}
module.exports={ListenerSettings};
