import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseTypedPlan} from './dexa_tool_plan_v3.mjs';
import {executeTypedPlan} from './dexa_tool_plan_executor_v3.mjs';
import {openWorkflow} from './dexa_workflow_kernel.mjs';
import {reconcileNativeUiFileSend} from './dexa_native_ui_observation_v1.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const upload='a'.repeat(64),digest='b'.repeat(64),target='File Transfer';
const fname='telegram_video_2026-11-01.mp4',size=4057059;
const material={state:'READY_VERIFIED',upload_id:upload,sha256_hex:digest,filename:fname,size_bytes:size};
const args={target,upload_id:upload};
const key=sha('v10\0'+target+'\0cf-file:'+upload+':'+digest);
const mkroot=()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dexa-ui-witness-'));fs.chmodSync(dir,0o700);return dir;};
function marker(dir){
 const f=path.join(dir,key+'.attempt');
 fs.writeFileSync(f,'ATTEMPTED_NO_RETRY\n',{mode:0o600});
 return f;
}
function proofFile(dir,{change={},timeNs=null}={}){
 const m=fs.statSync(path.join(dir,key+'.attempt'),{bigint:true});
 const actual=(timeNs||BigInt(Date.now())*1000000n)+1000000n;
 const j={schema:'cf.wechat.native-outbound-ui-receipt.v1',marker_key:key,
  target,upload_id:upload,sha256_hex:digest,filename:fname,size_bytes:size,
  state:'UI_OUTBOUND_OBSERVED',direction:'out',fresh_outbound_row:true,
  send_enabled_after:false,send_clicks:1,provider_send_performed:true,
  provider_confirmed:false,blind_retry_safe:false,
  verification_source:'native_same_client_atspi_x11',
  row_evidence:'unique_video_row',observed_at_ns:String(actual),
  attempt_mtime_ns:String(m.mtimeNs),...change};
 fs.writeFileSync(path.join(dir,key+'.observed.json'),JSON.stringify(j)+'\n',{flag:'wx',mode:0o600});
 return j;
}
function read(dir,overrides={}){
 return reconcileNativeUiFileSend({capabilityId:'tool.cf.wechat_file_send',
  requestArgs:args,material,dispatchedAt:new Date(Date.now()-2000).toISOString(),
  markerDir:dir,...overrides});
}
test('the real native v10 attempt marker and immutable verified video UI proof reconcile without provider call',()=>{
 const dir=mkroot();
 try{
  marker(dir);proofFile(dir);
  const v=read(dir);
  assert.ok(v,'native UI observation must be admitted');
  assert.equal(v.result.state,'UI_OUTBOUND_OBSERVED');
  assert.equal(v.result.provider_confirmed,false);
  assert.equal(v.effectProof.providerTool,'wechat_file_send');
  assert.equal(v.effectProof.receiptBasis,'CF_NATIVE_UI_FRESH_OUTBOUND_ONLY_NOT_PROVIDER_DELIVERY');
  assert.equal(v.evidenceKind,'PROVIDER_NATIVE_DURABLE_UI_POSTDISPATCH');
  assert.match(v.nativeObservationDigest,/^[0-9a-f]{64}$/);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('one durably marked native red-failure resend may reconcile, but missing or forged retry never does',()=>{
 const dir=mkroot();
 try{
  marker(dir);
  proofFile(dir,{change:{row_evidence:'failed_video_resend_once',resend_confirm_clicks:1},
   timeNs:BigInt(Date.now()+1000)*1000000n});
  assert.equal(read(dir),null,'no retry marker must fail closed');
  fs.writeFileSync(path.join(dir,key+'.resend'),
   'EXPLICIT_UI_FAILED_ROW_RETRY_ONCE\n',{mode:0o600});
  assert.ok(read(dir)?.result?.resend_confirm_clicks===1);
  fs.chmodSync(path.join(dir,key+'.resend'),0o644);
  assert.equal(read(dir),null,'insecure retry marker');
  fs.chmodSync(path.join(dir,key+'.resend'),0o600);
  fs.writeFileSync(path.join(dir,key+'.resend'),'WRONG\n',{mode:0o600});
  assert.equal(read(dir),null,'forged retry marker content');
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('wrong recipient, hash, upload, file, size, stale time or absent attempt NEVER reconciles',()=>{
 const dir=mkroot();
 try{
  assert.equal(read(dir),null);
  marker(dir);
  assert.equal(read(dir),null);
  proofFile(dir);
  for(const bad of [
   {requestArgs:{...args,target:'Other'}},
   {requestArgs:{...args,upload_id:'c'.repeat(64)}},
   {material:{...material,sha256_hex:'d'.repeat(64)}},
   {material:{...material,filename:'different.mp4'}},
   {material:{...material,size_bytes:size+1}},
   {dispatchedAt:new Date(Date.now()+15000).toISOString()},
   {capabilityId:'tool.cf.wechat_file_upload'}
  ])assert.equal(read(dir,bad),null);
  fs.unlinkSync(path.join(dir,key+'.attempt'));
  assert.equal(read(dir),null);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('evidence failed/failed click or unverified direction cannot become a send receipt',()=>{
 for(const change of [
  {send_clicks:0},{send_enabled_after:true},{fresh_outbound_row:false},
  {direction:'in'},{provider_confirmed:true},
  {verification_source:'screenshot_not_native'},
  {row_evidence:'guess_from_preview'},{attempt_mtime_ns:'1234'}
 ]){
  const dir=mkroot();
  try{marker(dir);proofFile(dir,{change});assert.equal(read(dir),null)}
  finally{fs.rmSync(dir,{recursive:true,force:true})}
 }
});
test('only exact once-verified UI witness after the dispatch recovers IN_DOUBT durable workflow; NEVER resends',async()=>{
 const ids=['tool.cf.wechat_conversation_list','tool.cf.wechat_file_upload','tool.cf.wechat_file_send'];
 const p={schema:'dexa.tool-plan.v3',steps:[
  {id:1,kind:'TOOL',capabilityId:ids[0],args:{limit:20,max_pages:1},deps:[]},
  {id:2,kind:'TRANSFORM',op:'MATCH',mode:'normalized_exact',
   source:{step:1,path:['conversations']},query:target,fields:[['name']],deps:[1]},
  {id:3,kind:'TOOL',capabilityId:ids[1],args:{action:'status',upload_id:upload},deps:[]},
  {id:4,kind:'TOOL',capabilityId:ids[2],deps:[2,3],
   args:{target:{$ref:{step:2,path:['name']}},upload_id:{$ref:{step:3,path:['upload_id']}}}}
 ],checks:[{step:4,path:['state'],op:'equal',value:'UI_OUTBOUND_OBSERVED'}],
 output:{step:4,path:['state'],format:'text'},answer:{kind:'text'}};
 const raw=JSON.stringify(p),parsed=parseTypedPlan(raw,ids);
 const root=mkroot(),wfdir=fs.mkdtempSync(path.join(os.tmpdir(),'dexa-wf-native-ui-'));
 const mission=randomUUID();let actualSendAttempts=0,providerReadCalls=0;
 const open=()=>openWorkflow({storeDir:wfdir,missionId:mission,
  planVersion:1,planRaw:raw,steps:parsed.steps});
 const invoke=async({capabilityId})=>{
  if(capabilityId===ids[0]){
   providerReadCalls++;
   return{result:{state:'ACHIEVED',conversations:[{name:target,conversation_ref:'name:transfer'}]},
    providerTool:'wechat_conversation_list'};
  }
  if(capabilityId===ids[1])return{result:material,
   providerTool:'wechat_file_upload',
   effectProof:{providerTool:'wechat_file_upload',outcome:'PROVIDER_REPORTED_SUCCEEDED'}};
  actualSendAttempts++;marker(root);
  throw Object.assign(new Error('CATALOG_EFFECT_RESULT_UNVERIFIED'),{code:'CATALOG_EFFECT_RESULT_UNVERIFIED'});
 };
 const recovery=opts=>reconcileNativeUiFileSend({...opts,markerDir:root});
 const run=()=>open().then(workflow=>executeTypedPlan(raw,{
  allowedCapabilities:ids,workflow,toolInvoker:invoke,
  connectionProbe:async()=>true,nativeUiReceiptReader:recovery
 }));
 try{
  const first=await run();
  assert.equal(first.state,'OUTCOME_UNKNOWN');
  assert.equal(actualSendAttempts,1);
  const pending=(await open()).pendingDispatch(parsed.steps[3]);
  assert.ok(pending?.dispatchedAt);
  assert.equal(pending.state,'DISPATCHED');
  proofFile(root);
  const recovered=await run();
  assert.equal(recovered.state,'SUCCEEDED_VERIFIED',JSON.stringify(recovered).slice(0,2000));
  assert.equal(actualSendAttempts,1,'reconciliation must never resend');
  assert.equal(recovered.proof.verifiedReceipts.at(-1).evidenceKind,
   'PROVIDER_NATIVE_DURABLE_UI_POSTDISPATCH');
  assert.equal(recovered.proof.verifiedReceipts.at(-1).effectProof.independentlyReconciled,false);
  const third=await run();
  assert.equal(third.state,'SUCCEEDED_VERIFIED');
  assert.equal(actualSendAttempts,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(wfdir,{recursive:true,force:true})}
});
