// Material-plane file delivery, equal in semantics to WhatsApp/Alibaba
// download tickets, but isolated with a WeChat-only route and TTL.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
const fail=code=>{const e=new Error(code);e.code=code;throw e};
const MIME=/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
export function installWeChatMaterialDownloadBridge({app,materialUpload,
 root='/run/pcg-material-files',now=()=>Date.now(),
 ttlMs=55*60*1000,fsImpl=fs}={}){
 if(!app||typeof app.get!=='function'||
    !materialUpload||typeof materialUpload.delete!=='function'||
    typeof root!=='string'||!path.isAbsolute(root))
  fail('WECHAT_DOWNLOAD_BRIDGE_INVALID');
 const staged=new Map();
 const stage=async ready=>{
  if(staged.size>=100)fail('WECHAT_DOWNLOAD_CAPACITY_EXCEEDED');
  const name=String(ready?.filename||'');
  const m=/^pcgfile:([0-9a-f]{64})$/.exec(String(ready?.material_file_handle||''));
  if(!m||name.length<1||name.length>128||
     /[\/\\\u0000-\u001f\u007f\"]/.test(name)||
     !Number.isSafeInteger(ready?.size_bytes)||ready.size_bytes<=0)
   fail('WECHAT_DOWNLOAD_MATERIAL_IDENTITY_INVALID');
  const filePath=path.join(root,m[1]+'-'+name);
  let stat,real;
  try{stat=fsImpl.lstatSync(filePath);real=fsImpl.realpathSync(filePath)}
  catch{fail('WECHAT_DOWNLOAD_MATERIAL_NOT_READY')}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==ready.size_bytes||
     !real.startsWith(path.resolve(root)+path.sep))
   fail('WECHAT_DOWNLOAD_MATERIAL_NOT_VERIFIED');
  const id=randomBytes(32).toString('hex');
  const item={filePath,size:stat.size,name,
   type:MIME.test(String(ready.media_type||''))?ready.media_type:'application/octet-stream',
   expires:now()+ttlMs,upload_id:String(ready.upload_id||'')};
  staged.set(id,item);
  const timer=setTimeout(async()=>{
   staged.delete(id);
   if(/^[0-9a-f]{64}$/.test(item.upload_id))
    try{await materialUpload.delete(item.upload_id)}catch{}
  },ttlMs);
  timer.unref?.();
  return {download_id:id,download_path:'/mcp/wechat-file/'+id,
   filename:name,mime_type:item.type,size_bytes:item.size,
   expires_after_seconds:Math.floor(ttlMs/1000)};
 };
 app.get('/mcp/wechat-file/:download_id',(req,res)=>{
  const id=String(req?.params?.download_id||'');
  const item=/^[0-9a-f]{64}$/.test(id)?staged.get(id):null;
  if(!item||item.expires<=now()){
   res.status(404).json({error:'WeChat staged file not found or expired.'});return;
  }
  let stat;
  try{stat=fsImpl.lstatSync(item.filePath)}catch{}
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size!==item.size){
   res.status(410).json({error:'WeChat staged file unavailable.'});return;
  }
  res.setHeader('content-type',item.type);
  res.setHeader('content-disposition','attachment; filename="'+item.name+'"');
  res.setHeader('content-length',String(item.size));
  res.setHeader('cache-control','private, no-store, max-age=0');
  res.setHeader('x-content-type-options','nosniff');
  fsImpl.createReadStream(item.filePath).pipe(res);
 });
 return stage;
}
