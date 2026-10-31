import {registerWeChatMediaTools} from './wechat-media-tools.mjs';
import {strict as assert} from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const z=new Proxy({}, {get:()=>()=>z});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wx-r270-'));
try {
 const fileId='a'.repeat(64),uploadId='b'.repeat(64),filename='large.bin';
 const bytes=Buffer.alloc(256*1024+7,123);
 fs.writeFileSync(path.join(root,fileId+'-'+filename),bytes);
 const hash=createHash('sha256').update(bytes).digest('hex');
 const transport={create:async()=>({}),status:async()=>({}),delete:async()=>({}),append:async()=>({}),
 ready:async()=>({material_file_handle:'pcgfile:'+fileId,filename,size_bytes:bytes.length,sha256_hex:hash}),markSendStarted:async()=>{throw Error('should not be reached')}};
 const tools=new Map();let seen=0;
 const server={registerTool:(name,opts,fn)=>tools.set(name,fn)};
 registerWeChatMediaTools(server,z,{materialUpload:transport,materialRoot:root,
 postStream:async(endpoint,meta,stream)=>{
  assert.equal(endpoint,'/file-send-stream');assert.equal(meta.data_base64,undefined);
  const h=createHash('sha256');for await(const part of stream){seen+=part.length;h.update(part)}
  assert.equal(h.digest('hex'),hash);
  return {state:'DRY_RUN_READY',filename,file_size:bytes.length,sha256_hex:hash,private_bytes_verified:true,effect_performed:false,provider_send_performed:false};
 }});
 const answer=(await tools.get('wechat_file_send')({target:'File Transfer',upload_id:uploadId,dry_run:true})).structuredContent;
 assert.equal(answer.state,'DRY_RUN_READY',JSON.stringify(answer));assert.equal(seen,bytes.length);
 console.log('R270_STREAM_256K_MOCK_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true})}
