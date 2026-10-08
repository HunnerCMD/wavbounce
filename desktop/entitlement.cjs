'use strict';
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),path=require('node:path');
const License=require('../shared/license.cjs');
const FREE_LIMITS={listeners:1,sources:1,groups:false};
const PRO_LIMITS={listeners:4,sources:4,groups:true};

// Offline Free/Pro state for one installation. Persists only a signed license key;
// entitlement is re-derived from it every load, so replacing the embedded public key
// (shared/license.cjs) naturally retires keys signed with a retired signing key.
class Entitlement extends EventEmitter {
  constructor(directory,{publicKey}={}){super();this.file=path.join(directory,'pro-license.json');this.publicKey=publicKey;this.pro=false;this.key=null;this.payload=null;}
  async load(){
    try{
      const saved=JSON.parse(await fs.readFile(this.file,'utf8'));
      if(!saved||typeof saved!=='object'||Array.isArray(saved)||typeof saved.key!=='string')throw new Error('malformed');
      const result=License.verify(saved.key,this.publicKey);
      if(!result.valid)throw new Error('invalid');
      this.key=saved.key;this.pro=true;this.payload=result.payload;
    }catch(error){
      if(error.code&&error.code!=='ENOENT')this.emit('notice','Saved WavBounce Pro license could not be read. Running as Free.');
      this.key=null;this.pro=false;this.payload=null;
    }
    return this.state();
  }
  async activate(key){
    const result=License.verify(key,this.publicKey);
    if(!result.valid)throw new Error(result.reason);
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const temporary=this.file+'.tmp';
    await fs.writeFile(temporary,JSON.stringify({v:1,key}),{mode:0o600});
    await fs.rename(temporary,this.file);
    this.key=key;this.pro=true;this.payload=result.payload;
    return this.state();
  }
  async remove(){
    await fs.rm(this.file,{force:true});
    this.key=null;this.pro=false;this.payload=null;
    return this.state();
  }
  state(){return {pro:this.pro,name:this.payload?.name||null,issued:this.payload?.issued||null};}
  get limits(){return this.pro?PRO_LIMITS:FREE_LIMITS;}
}
module.exports={Entitlement,FREE_LIMITS,PRO_LIMITS};
