import {createHash, createPublicKey, randomUUID, timingSafeEqual, verify} from 'node:crypto';
const KEY = createPublicKey('-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFyNxNH07DWrtEvvZd6AZDvt8t0yXOkk8fGuW5QD8OVU=\n-----END PUBLIC KEY-----');
const devices = new Map(), jobs = new Map(), nonces = new Map();
const now = () => Date.now();
const digest = v => createHash('sha256').update(v).digest('hex');
const deviceOk = (req,id) => {
  const d=devices.get(id),token=req.headers['x-dexa-device-token'];
  return !!(d&&typeof token==='string'&&/^[a-f0-9]{64}$/.test(token)&&
    timingSafeEqual(Buffer.from(d.hash,'hex'),Buffer.from(digest(token),'hex')));
};
const send=(res,status,body)=>{
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
};
const read=async(req,max=1024*1024)=>{
  const arr=[];let size=0;
  for await(const c of req){size+=c.length;if(size>max)throw Error('BODY_TOO_LARGE');arr.push(c);}
  return Buffer.concat(arr).toString('utf8');
};
const signed=(req,url,raw)=>{
  const stamp=req.headers['x-dexa-timestamp'],nonce=req.headers['x-dexa-nonce'],sig=req.headers['x-dexa-signature'];
  if(typeof stamp!=='string'||!/^\d{13}$/.test(stamp)||Math.abs(now()-Number(stamp))>120000)return false;
  if(typeof nonce!=='string'||!/^[0-9a-f-]{36}$/.test(nonce)||nonces.has(nonce))return false;
  if(typeof sig!=='string'||sig.length>200||sig.length<70)return false;
  const message=[req.method,url.pathname+url.search,stamp,nonce,raw].join('\n');
  let ok=false;
  try{ok=verify(null,Buffer.from(message),KEY,Buffer.from(sig,'base64'));}catch{}
  if(ok)nonces.set(nonce,now());
  return ok;
};
function cleanup(){
  const t=now();
  for(const [id,v] of nonces)if(t-v>180000)nonces.delete(id);
  for(const [id,j] of jobs)if(t-j.created>3600000)jobs.delete(id);
  for(const [id,d] of devices)if(t-d.last>86400000)devices.delete(id);
}
const safeDetail=x=>{
  try {return JSON.parse(JSON.stringify(x).slice(0,60000));}
  catch{return {error:'DETAIL_NOT_SERIALIZABLE'};}
};
function record(j,stage,detail=null){
  const item={at:now(),stage};
  if(detail!==null)item.detail=safeDetail(detail);
  j.events.push(item);if(j.events.length>500)j.events.shift();
  j.stage=stage;
  if(['DONE','FAILED','CANCELLED','EXPIRED','MONITOR_TIMEOUT'].includes(stage)){j.terminal=true;j.finished=now();j.script=null;}
  console.log('DXA_REMOTE_EVENT '+JSON.stringify({run:j.id,slot:j.slot,stage,at:item.at}));
}
export function createRemoteGateway(){
  return async function route(req,res,url) {
    if(!url.pathname.startsWith('/api/remote/'))return false;
    cleanup();
    const endpoint=url.pathname.slice(12);
    const fail=(code,status=400)=>send(res,status,{ok:false,code});
    try{
      if(req.method==='POST'&&endpoint==='device/register'){
        const o=JSON.parse(await read(req,2000));
        if(!/^[0-9a-f-]{36}$/.test(o.id||'')||!/^[a-f0-9]{64}$/.test(o.token||''))return fail('INVALID_DEVICE');
        const prior=devices.get(o.id),hash=digest(o.token);
        if(prior&&prior.hash!==hash)return fail('TOKEN_CHANGED',403);
        if(devices.size>=32&&!prior)return fail('DEVICE_CAPACITY',429);
        devices.set(o.id,{hash,last:now(),count:Number(o.count)||2,armed:true});
        return send(res,200,{ok:true,id:o.id});
      }
      if(req.method==='POST'&&endpoint==='device/disable'){
        const o=JSON.parse(await read(req,2000));
        if(!deviceOk(req,o.id))return fail('DEVICE_AUTH',401);
        devices.delete(o.id);
        for(const j of jobs.values())if(j.device===o.id&&!j.terminal)record(j,'CANCELLED');
        return send(res,200,{ok:true});
      }
      if(req.method==='GET'&&endpoint==='device/next'){
        const id=url.searchParams.get('id');
        if(!deviceOk(req,id))return fail('DEVICE_AUTH',401);
        const d=devices.get(id);d.last=now();
        const j=[...jobs.values()].find(j=>j.device===id&&j.stage==='QUEUED');
        if(!j)return send(res,200,{ok:true,job:null});
        if(now()-j.created>300000){record(j,'EXPIRED');return send(res,200,{ok:true,job:null});}
        record(j,'DELIVERED');
        return send(res,200,{ok:true,job:{id:j.id,slot:j.slot,source:j.script,statusKey:j.statusKey}});
      }
      if(req.method==='POST'&&endpoint==='device/report'){
        const o=JSON.parse(await read(req,70000));
        if(!deviceOk(req,o.device))return fail('DEVICE_AUTH',401);
        const j=jobs.get(o.run);
        if(!j||j.device!==o.device||j.terminal)return fail('RUN_NOT_ACTIVE',404);
        if(typeof o.stage!=='string'||! /^[A-Z][A-Z0-9_]{1,64}$/.test(o.stage))return fail('BAD_STAGE');
        record(j,o.stage,o.detail??null);
        return send(res,200,{ok:true});
      }
      if(['admin/devices','admin/runs','admin/submit'].includes(endpoint)){
        const raw=req.method==='POST'?await read(req,1024*1024*4):'';
        if(!signed(req,url,raw))return fail('SIGNATURE_REQUIRED',401);
        if(req.method==='GET'&&endpoint==='admin/devices')
          return send(res,200,{ok:true,devices:[...devices].map(([id,d])=>({id,last:d.last,count:d.count,online:now()-d.last<20000}))});
        if(req.method==='GET'&&endpoint==='admin/runs'){
          const id=url.searchParams.get('id');
          const all=id?[jobs.get(id)].filter(Boolean):[...jobs.values()].slice(-40);
          return send(res,200,{ok:true,runs:all.map(j=>({
            id:j.id,device:j.device,slot:j.slot,stage:j.stage,created:j.created,
            terminal:!!j.terminal,finished:j.finished||null,events:j.events
          }))});
        }
        if(req.method==='POST'&&endpoint==='admin/submit'){
          const o=JSON.parse(raw);
          if(!devices.has(o.device)||now()-devices.get(o.device).last>40000)return fail('DEVICE_OFFLINE',409);
          if(!Number.isInteger(o.slot)||o.slot<0||o.slot>=devices.get(o.device).count)return fail('INVALID_SLOT');
          if(typeof o.source!=='string'||!o.source.trim())return fail('EMPTY_CODE');
          if(o.statusKey&& !/^__dexa[A-Za-z0-9_$]{1,80}$/.test(o.statusKey))return fail('INVALID_STATUS_KEY');
          if([...jobs.values()].some(j=>j.device===o.device&&!j.terminal))return fail('DEVICE_BUSY',409);
          const j={id:randomUUID(),device:o.device,slot:o.slot,script:o.source,
            statusKey:o.statusKey||null,created:now(),events:[],stage:'',terminal:false};
          jobs.set(j.id,j);record(j,'QUEUED');
          return send(res,202,{ok:true,id:j.id});
        }
      }
      return fail('NOT_FOUND',404);
    }catch(e){return fail(e.message==='BODY_TOO_LARGE'?'BODY_TOO_LARGE':'BAD_REQUEST',e.message==='BODY_TOO_LARGE'?413:400);}
  };
}