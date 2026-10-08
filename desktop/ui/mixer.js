import {AudioEngine} from './audio.js';

// Native Web Audio nodes mix decoded streams; no per-sample JavaScript loop.
export class ReceiverMixer {
  constructor({onState=()=>{},onStats=()=>{},testing=false}={}){
    Object.assign(this,{onState,onStats,testing});this.channels=new Map();this.volume=.35;this.muted=false;this.sink='';this.monitoring=true;this.outputBlocked=false;
  }
  async prepare(){
    if(!this.context){
      const context=new AudioContext({sampleRate:48000,latencyHint:'interactive'});this.context=context;
      this.bus=context.createGain();this.master=context.createGain();this.output=context.createGain();this.meter=context.createAnalyser();this.meter.fftSize=256;this.levelSamples=new Float32Array(256);
      this.bus.connect(this.master).connect(this.meter).connect(this.output).connect(context.destination);
      this.master.gain.value=this.muted?0:this.volume;this.output.gain.value=this.testing?0:1;
      if(this.sink){try{await context.setSinkId(this.sink);}catch{this.outputBlocked=true;await context.suspend();throw new Error('Choose an available output to resume.');}}
    }
    if(!this.outputBlocked)await this.context.resume();
  }
  add(id){
    if(this.channels.has(id))return this.channels.get(id);
    const channel={id,volume:1,muted:false,epoch:0};
    channel.engine=new AudioEngine({muted:true,onState:state=>{if(this.channels.get(id)===channel)this.onState(id,state,channel.epoch);},onStats:stats=>{if(this.channels.get(id)===channel){channel.stats=stats;this.onStats(id,stats);}},onStream:async(stream,pc)=>{
      await this.prepare();if(this.channels.get(id)!==channel||channel.engine.receiver!==pc)return;
      this.detach(channel);channel.input=this.context.createMediaStreamSource(stream);channel.gain=this.context.createGain();
      channel.gain.gain.value=channel.muted?0:channel.volume;channel.input.connect(channel.gain).connect(this.bus);this.headroom();
    }});
    this.channels.set(id,channel);this.headroom();this.setMonitoringEnabled(this.monitoring);return channel;
  }
  async createOffer(id,epoch){const channel=this.add(id);this.reset(id);channel.epoch=epoch;await this.prepare();if(this.channels.get(id)!==channel||channel.epoch!==epoch)throw new Error('Connection stopped.');return channel.engine.createOffer();}
  async acceptAnswer(id,epoch,description){const channel=this.channels.get(id);if(channel?.epoch===epoch)await channel.engine.acceptAnswer(description);}
  detach(channel){channel.input?.disconnect();channel.gain?.disconnect();channel.input=null;channel.gain=null;}
  reset(id){const channel=this.channels.get(id);if(channel){channel.epoch++;this.detach(channel);channel.engine.closeReceiver();channel.stats=null;}}
  remove(id){const channel=this.channels.get(id);if(channel){this.reset(id);this.channels.delete(id);this.headroom();}if(!this.channels.size){this.setMonitoringEnabled(this.monitoring);this.context?.suspend().catch(()=>{});}}
  headroom(){
    if(!this.bus)return;
    // Retain the same balance when a channel is muted or temporarily reconnects.
    const sum=[...this.channels.values()].reduce((total,c)=>total+c.volume,0);
    this.bus.gain.setTargetAtTime(1/Math.max(1,sum),this.context.currentTime,.02);
  }
  setChannelVolume(id,value){const c=this.channels.get(id);if(!c)return;c.volume=Math.max(0,Math.min(1,value));if(c.gain)c.gain.gain.setTargetAtTime(c.muted?0:c.volume,this.context.currentTime,.01);this.headroom();}
  setChannelMuted(id,muted){const c=this.channels.get(id);if(!c)return;c.muted=muted===true;if(c.gain)c.gain.gain.setTargetAtTime(c.muted?0:c.volume,this.context.currentTime,.01);}
  setVolume(value){this.volume=Math.max(0,Math.min(1,value));if(this.master)this.master.gain.setTargetAtTime(this.muted?0:this.volume,this.context.currentTime,.01);}
  setMuted(value){this.muted=value===true;this.setVolume(this.volume);}
  async setOutput(id){
    this.sink=id;this.outputBlocked=true;
    if(this.context){await this.context.suspend();try{await this.context.setSinkId(id);await this.context.resume();}catch{throw new Error('That output is unavailable. Choose another output.');}}
    this.outputBlocked=false;
  }
  async pauseOutput(){this.outputBlocked=true;await this.context?.suspend();}
  setMonitoringEnabled(enabled){
    this.monitoring=enabled;clearInterval(this.poll);this.poll=null;
    for(const c of this.channels.values())c.engine.lastStats=null;
    if(enabled&&this.channels.size)this.poll=setInterval(()=>{
      // A small visual sample once per second; mixing itself stays in native nodes.
      if(this.meter){this.meter.getFloatTimeDomainData(this.levelSamples);this.level=Math.sqrt(this.levelSamples.reduce((sum,v)=>sum+v*v,0)/this.levelSamples.length);}
      for(const c of this.channels.values())if(c.engine.receiver)c.engine.sample(c.engine.receiver).catch(()=>{});
    },1000);
  }
  async stop(){
    clearInterval(this.poll);this.poll=null;for(const id of this.channels.keys())this.reset(id);this.channels.clear();
    const context=this.context;this.context=null;this.bus=null;this.master=null;this.output=null;this.meter=null;this.level=0;if(context)await context.close();this.outputBlocked=false;
  }
}
