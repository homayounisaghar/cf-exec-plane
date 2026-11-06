'use strict';
(() => {
  if (!window.DexaHost) return;
  const ID_KEY='dexa-remote-device-v15', SECRET_KEY='dexa-remote-device-token-v15', ENABLED_KEY='dexa-remote-armed-v15';
  const uuid=()=>crypto.randomUUID();
  const id=localStorage.getItem(ID_KEY)||uuid();
  localStorage.setItem(ID_KEY,id);
  const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);
  const token=localStorage.getItem(SECRET_KEY)||[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
  localStorage.setItem(SECRET_KEY,token);
  let enabled=localStorage.getItem(ENABLED_KEY)==='yes', enrolled=false, busy=false, lastRegister=0;
  let lastStatus='',lastRun=null;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const state=window.DexaRemote={id,enabled,enrolled:false,lastRun:null,error:null};
  const control=document.createElement('div');
  control.className='notice';
  control.style.margin='10px 0';
  const header=document.querySelector('main .kpis');
  header?.insertAdjacentElement('afterend',control);
  function paint(){
    control.replaceChildren();
    const t=document.createElement('span');
    t.textContent='کنترل مستقیم از راه دور: '+(enabled?(enrolled?'متصل':'در حال اتصال'):'خاموش')+' | شناسهٔ دستگاه: '+id.slice(0,8);
    control.appendChild(t);
    const b=document.createElement('button');b.style.margin='5px';
    b.textContent=enabled?'قطع کنترل از راه دور':'فعال‌کردن کنترل از راه دور';
    b.onclick=async()=>{
      if(enabled){
        enabled=false;localStorage.setItem(ENABLED_KEY,'no');
        try{await api('device/disable','POST',{id});}catch{}
        try{await nativeCall('remote-arm',{enabled:false});}catch{}
        enrolled=false;
      }else{
        try{
          await nativeCall('remote-arm',{enabled:true});
          enabled=true;localStorage.setItem(ENABLED_KEY,'yes');lastRegister=0;
        }catch(e){state.error=String(e.message||e);}
      }
      state.enabled=enabled;state.enrolled=enrolled;paint();
    };
    control.appendChild(b);
    if(state.error){
      const s=document.createElement('span');
      s.textContent=' | خطا: '+state.error.slice(0,80);
      control.appendChild(s);
    }
  }
  async function api(path,method='GET',payload){
    const h={'x-dexa-device-token':token};
    if(method==='POST')h['content-type']='application/json';
    const r=await fetch('/api/remote/'+path,{
      method,headers:h,cache:'no-store',
      body:payload===undefined?undefined:JSON.stringify(payload)
    });
    const j=await r.json();
    if(!r.ok||!j.ok)throw Error(j.code||'REMOTE_ERROR');
    return j;
  }
  async function register(){
    if(!hostState||!window.DexaHost)throw Error('NO_ANDROID_HOST');
    await api('device/register','POST',{id,token,count:hostState.count});
    enrolled=true;lastRegister=Date.now();state.enrolled=true;state.error=null;paint();
  }
  const trimmed=(value)=>{
    try {
      const json=JSON.stringify(value);
      if(json===undefined)return {valueType:typeof value};
      if(json.length<=50000)return JSON.parse(json);
      return {truncated:true,length:json.length,preview:json.slice(0,48000)};
    }catch(e){return {serializable:false,error:String(e)};}
  };
  async function report(run,stage,detail){
    if(!enrolled)return;
    const safe=detail===undefined?null:trimmed(detail);
    await api('device/report','POST',{device:id,run,stage,detail:safe});
  }
  const readState=(key)=>{
    if(!key)return 'null';
    return "(()=>{const x=window["+JSON.stringify(key)+"];return x?{stage:x.stage||null,error:x.error||null,running:!!x.running,sent:!!x.sent,deleted:!!x.deleted,match:x.target&&location.pathname===x.target}:null})()";
  };
  async function execute(job){
    const run=job.id,slot=job.slot,source=job.source,key=job.statusKey;
    state.lastRun=run;lastRun=run;state.error=null;paint();
    try{
      if(!enabled)throw Error('DISARMED');
      if(!hostState||slot<0||slot>=hostState.count)throw Error('INVALID_BROWSER');
      await report(run,'ACCEPTED',{slot,sourceLength:source.length});
      const setup="(()=>{const id="+JSON.stringify(run)+";const j=(window.__dexaRemoteEvents=window.__dexaRemoteEvents||{})[id]={events:[]};window.__dexaReport=(stage,detail)=>{j.events.push({time:Date.now(),stage:String(stage),detail});if(j.events.length>500)j.events.shift()};return true})()";
      await evalBatched(slot,setup,()=>{},true);
      await report(run,'TRANSFER_START',{size:source.length});
      const expression="(()=>{try{const result=("+source+");if(result&&typeof result.then==='function'){result.then(v=>window.__dexaReport('ASYNC_RESOLVED',v),e=>window.__dexaReport('ASYNC_FAILED',{error:String(e)}));return {ok:true,async:true};}return {ok:true,async:false,value:result};}catch(e){return {ok:false,error:String(e&&e.stack||e)}}})()";
      const result=await evalBatched(slot,expression,()=>{},true);
      if(result?.ok===false)throw Error(result.error||'SCRIPT_ERROR');
      await report(run,'EVAL_RETURNED',result);
      let final='DONE', old='', resolved=!!(!key&&!result?.async);
      const limit=Date.now()+(resolved?5000:150000);
      while(Date.now()<limit&&enabled){
        const snapshot=await evalBatched(slot,
          "(()=>{const j=window.__dexaRemoteEvents?.["+JSON.stringify(run)+"];const events=j?j.events.splice(0,40):null;const x="+readState(key)+";return {events,state:x}})()",()=>{},true);
        if(!snapshot?.events){final='FAILED';await report(run,'TRACE_LOST');break;}
        for(const ev of snapshot.events){
          const label=String(ev.stage||'').toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,50);
          if(label)await report(run,'STEP_'+label,{time:ev.time,detail:ev.detail});
          if(['ASYNC_RESOLVED','ASYNC_FAILED'].includes(label)){
            resolved=true;
            if(label==='ASYNC_FAILED')final='FAILED';
          }
        }
        const status=snapshot.state;
        if(status&&typeof status==='object'){
          const repr=JSON.stringify(status);
          if(repr!==old){old=repr;await report(run,'STATE',{status});}
          if(/^(DONE|FAILED|ERROR|CANCELLED)/i.test(status.stage||'')){
            resolved=true;if(!/^DONE$/i.test(status.stage))final='FAILED';
          }
        }
        if(resolved)break;
        await sleep(1500);
      }
      if(!resolved&&final==='DONE')final='MONITOR_TIMEOUT';
      if(!enabled)final='CANCELLED';
      await report(run,final,{slot});
    }catch(e){
      state.error=String(e.message||e);paint();
      try{await report(run,'FAILED',{error:String(e.stack||e)});}catch{}
    }
  }
  async function cycle(){
    if(busy||!enabled||!window.DexaHost||!hostState)return;
    if(hostState.remoteArmed!==true){enabled=false;localStorage.setItem(ENABLED_KEY,'no');state.enabled=false;paint();return;}
    busy=true;
    try{
      if(!enrolled||Date.now()-lastRegister>12000)await register();
      const job=(await api('device/next?id='+encodeURIComponent(id))).job;
      if(job)await execute(job);
      state.error=null;
    }catch(e){
      state.error=String(e.message||e);
      if(/DEVICE_AUTH/.test(state.error)){enrolled=false;state.enrolled=false;}
      paint();
    }finally{busy=false;}
  }
  paint();
  setInterval(()=>cycle().catch(()=>{}),2500);
  cycle().catch(()=>{});
})();