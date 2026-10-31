import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { registerWeChatMediaTools } from "./wechat-media-tools.mjs";

const chain = new Proxy({}, {get:()=>()=>chain});
const z={enum:()=>chain,string:()=>chain,number:()=>chain,boolean:()=>chain};
function make(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"wechat-dryrun-"));
 const bytes=Buffer.from("Owner-self WeChat file dry-run\n");
 const handle="a".repeat(64),upload="b".repeat(64),name="safe-probe.txt";
 const file=path.join(root,handle+"-"+name);
 fs.writeFileSync(file,bytes,{mode:0o600});
 const sha=createHash("sha256").update(bytes).digest("hex");
 let mark=0,calls=[];
 const transport={create:async()=>({}),status:async()=>({}),delete:async()=>({}),
  append:async()=>({}),ready:async()=>({material_file_handle:"pcgfile:"+handle,
   upload_id:upload,filename:name,size_bytes:bytes.length,sha256_hex:sha}),
  markSendStarted:async()=>{mark++}};
 const map=new Map();
 const server={registerTool:(n,d,cb)=>map.set(n,cb)};
 registerWeChatMediaTools(server,z,{materialUpload:transport,materialRoot:root,
  postJson:async(p,b)=>{calls.push({p,b});return {
   state:"DRY_RUN_READY",filename:name,file_size:bytes.length,sha256_hex:sha,
   private_bytes_verified:true,effect_performed:false,provider_send_performed:false
  }}});
 return {root,bytes,handle,upload,name,file,sha,calls,transport,
  call:args=>map.get("wechat_file_send")(args),marked:()=>mark,
  cleanup(){fs.rmSync(root,{recursive:true,force:true})}};
}
test("exact ready bytes reach only the local dry-run helper",async()=>{
 const x=make();
 try{
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.state,"DRY_RUN_READY");
  assert.equal(r.private_bytes_verified,true);
  assert.equal(r.provider_send_performed,false);
  assert.equal(r.provider_confirmed,false);
  assert.equal(x.calls.length,1);
  assert.equal(x.calls[0].p,"/file-send");
  assert.equal(Buffer.from(x.calls[0].b.data_base64,"base64").compare(x.bytes),0);
  assert.equal(x.calls[0].b.expected_sha256,x.sha);
  assert.equal(x.calls[0].b.dry_run,true);
  assert.equal(x.marked(),0);
 }finally{x.cleanup()}
});
test("real send and arbitrary recipient remain blocked before any file access",async()=>{
 const x=make();
 try{
  const live=(await x.call({target:"File Transfer",upload_id:x.upload})).structuredContent;
  const other=(await x.call({target:"Other",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(live.error.code,"WECHAT_FILE_LIVE_SEND_DISABLED");
  assert.equal(other.error.code,"WECHAT_FILE_SELF_CHAT_ONLY");
  assert.equal(x.calls.length,0);assert.equal(x.marked(),0);
 }finally{x.cleanup()}
});
test("allow_mark_read forbidden before helper call",async()=>{
 const x=make();
 try{
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true,allow_mark_read:true})).structuredContent;
  assert.equal(r.error.code,"WECHAT_FILE_MARK_READ_NOT_ALLOWED");
  assert.equal(x.calls.length,0);
 }finally{x.cleanup()}
});
test("changed bytes cannot be transferred",async()=>{
 const x=make();
 try{
  fs.appendFileSync(x.file,"unexpected");
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.state,"FAILED");
  assert.equal(x.calls.length,0);
 }finally{x.cleanup()}
});
test("modified same-length bytes cannot be transferred",async()=>{
 const x=make();
 try{
  fs.writeFileSync(x.file,Buffer.alloc(x.bytes.length,0x78));
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.error.code,"WECHAT_FILE_DRYRUN_SHA_MISMATCH");
  assert.equal(x.calls.length,0);
 }finally{x.cleanup()}
});
test("symlink material source cannot be followed",async()=>{
 const x=make();
 try{
  const real=x.file+".real";fs.renameSync(x.file,real);fs.symlinkSync(real,x.file);
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.error.code,"WECHAT_FILE_DRYRUN_SOURCE_NOT_READABLE");
  assert.equal(x.calls.length,0);
 }finally{x.cleanup()}
});
test("file above 128 KiB fails before reading",async()=>{
 const x=make();
 try{
  x.transport.ready=async()=>({material_file_handle:"pcgfile:"+x.handle,
   filename:x.name,size_bytes:131073,sha256_hex:x.sha});
  const r=(await x.call({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.error.code,"WECHAT_FILE_DRYRUN_MATERIAL_INVALID");
  assert.equal(x.calls.length,0);
 }finally{x.cleanup()}
});
test("helper response without private byte verification is rejected",async()=>{
 const x=make();
 try{
  x.calls.length=0;
  const first=x.call;
  // A local synthetic helper response cannot claim success with mismatched data.
  x.transport.ready=async()=>({material_file_handle:"pcgfile:"+x.handle,
   filename:x.name,size_bytes:x.bytes.length,sha256_hex:"f".repeat(64)});
  const r=(await first({target:"File Transfer",upload_id:x.upload,dry_run:true})).structuredContent;
  assert.equal(r.error.code,"WECHAT_FILE_DRYRUN_SHA_MISMATCH");
 }finally{x.cleanup()}
});
