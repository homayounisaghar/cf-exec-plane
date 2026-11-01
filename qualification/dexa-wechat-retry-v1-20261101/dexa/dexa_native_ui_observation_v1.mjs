// Read-only reconciliation of an ALREADY-dispatched WeChat file send.
// Only a same-host native-helper durable UI witness may close uncertainty.
// Never calls any provider, never retries a send, never uses screenshots or
// generic chat previews as authority for a specific file/attempt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nativeMaterialEffectProof} from './dexa_native_material_effect_v1.mjs';

const HEX=/^[0-9a-f]{64}$/;
const DEC=/^[0-9]{17,21}$/;
const SCHEMA='cf.wechat.native-outbound-ui-receipt.v1';
const sha=s=>createHash('sha256').update(s).digest('hex');
const secure=(p,{directory=false}={})=>{
 const st=fs.lstatSync(p,{bigint:true});
 if(st.isSymbolicLink()||st.uid!==BigInt(process.getuid())||
  (st.mode&0o077n)!==0n||(directory?!st.isDirectory():!st.isFile()))
  throw Error('NATIVE_UI_WITNESS_UNSAFE_FILE');
 if(!directory&&(st.mode&0o600n)!==0o600n)
  throw Error('NATIVE_UI_WITNESS_UNSAFE_MODE');
 return st;
};
function readSecure(p,maxBytes){
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const st=fs.fstatSync(fd,{bigint:true});
  if(st.uid!==BigInt(process.getuid())||!st.isFile()||
   (st.mode&0o077n)!==0n||st.size>BigInt(maxBytes)||
   st.size<1n)throw Error('NATIVE_UI_WITNESS_UNSAFE_CONTENT');
  const data=Buffer.alloc(Number(st.size));
  let bytes=0;
  while(bytes<data.length){
   const n=fs.readSync(fd,data,bytes,data.length-bytes,bytes);
   if(n<=0)throw Error('NATIVE_UI_WITNESS_SHORT_READ');
   bytes+=n;
  }
  return data.toString('utf8');
 }finally{fs.closeSync(fd)}
}
function sameRecord(j,expected){
 for(const [k,v]of Object.entries(expected))if(j[k]!==v)return false;
 return true;
}
export function reconcileNativeUiFileSend({
 capabilityId,requestArgs,material,dispatchedAt,
 markerDir=path.join(os.homedir(),'.local/state','wechat-send-v10'),
 nowMs=Date.now()
}={}){
 // Failure closed: absence/invalid/insecure/older record is NEVER a success.
 try{
  if(capabilityId!=='tool.cf.wechat_file_send'||
   typeof requestArgs?.target!=='string'||!requestArgs.target.trim()||
   !HEX.test(requestArgs?.upload_id)||!material||
   material.upload_id!==requestArgs.upload_id||
   material.state!=='READY_VERIFIED'||
   !HEX.test(material.sha256_hex)||
   !Number.isSafeInteger(material.size_bytes)||material.size_bytes<1||
   typeof material.filename!=='string'||!material.filename||
   !Number.isFinite(Date.parse(dispatchedAt)))return null;
  secure(markerDir,{directory:true});
  const key=sha('v10\0'+requestArgs.target+'\0cf-file:'+
   requestArgs.upload_id+':'+material.sha256_hex);
  const attempt=path.join(markerDir,key+'.attempt');
  const witnessed=path.join(markerDir,key+'.observed.json');
  const markerStat=secure(attempt);
  if(readSecure(attempt,128)!=='ATTEMPTED_NO_RETRY\n')return null;
  secure(witnessed);
  const raw=readSecure(witnessed,4096);
  const j=JSON.parse(raw);
  const expected={schema:SCHEMA,marker_key:key,
   target:requestArgs.target,upload_id:requestArgs.upload_id,
   sha256_hex:material.sha256_hex,filename:material.filename,
   size_bytes:material.size_bytes,
   state:'UI_OUTBOUND_OBSERVED',direction:'out',
   fresh_outbound_row:true,send_enabled_after:false,send_clicks:1,
   provider_send_performed:true,provider_confirmed:false,
   blind_retry_safe:false,verification_source:'native_same_client_atspi_x11'};
  if(!sameRecord(j,expected)||
   !['unique_video_row','exact_filename_row','failed_video_resend_once'].includes(j.row_evidence)||
   !DEC.test(j.observed_at_ns)||!DEC.test(j.attempt_mtime_ns))return null;
  const when=BigInt(j.observed_at_ns),since=BigInt(j.attempt_mtime_ns);
  if(j.row_evidence==='failed_video_resend_once'){
   if(j.resend_confirm_clicks!==1)return null;
   const retried=path.join(markerDir,key+'.resend');
   const retryStat=secure(retried);
   if(readSecure(retried,128)!=='EXPLICIT_UI_FAILED_ROW_RETRY_ONCE\n'||
      retryStat.mtimeNs<markerStat.mtimeNs||retryStat.mtimeNs>when)return null;
  }else if(j.resend_confirm_clicks!==undefined&&j.resend_confirm_clicks!==0){
   return null;
  }
  if(since!==markerStat.mtimeNs||when<since||when>BigInt(nowMs+3000)*1000000n||
   when<BigInt(Date.parse(dispatchedAt)-1200)*1000000n||
   since<BigInt(Date.parse(dispatchedAt)-1200)*1000000n)
   return null;
  const result={
   provider:'wechat',target:j.target,filename:j.filename,
   sha256_hex:j.sha256_hex,size_bytes:j.size_bytes,
   state:j.state,direction:j.direction,
   fresh_outbound_row:j.fresh_outbound_row,
   send_enabled_after:j.send_enabled_after,send_clicks:j.send_clicks,
   resend_confirm_clicks:j.resend_confirm_clicks||0,
   provider_send_performed:j.provider_send_performed,
   provider_confirmed:false,provider_fresh:false,
   blind_retry_safe:false,effect_may_have_occurred:true,
   verification_source:'native_durable_ui_observation'
  };
  const proof=nativeMaterialEffectProof({
   route:{id:capabilityId,cfName:'wechat_file_send'},
   requestArgs,result:undefined,response:result});
  if(proof?.outcome!=='PROVIDER_REPORTED_SUCCEEDED')return null;
  return Object.freeze({
   result:Object.freeze(result),effectProof:proof,
   providerTool:'wechat_file_send',
   evidenceKind:'PROVIDER_NATIVE_DURABLE_UI_POSTDISPATCH',
   nativeObservationDigest:sha(raw),dispatchedAt,
   observedAtNs:j.observed_at_ns
  });
 }catch{return null}
}
