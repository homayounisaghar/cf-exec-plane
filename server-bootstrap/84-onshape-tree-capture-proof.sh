#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
container="capability-fabric-onshape-server"
docker inspect "$container" >/dev/null 2>&1 || { echo "Onshape server container missing" >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "Onshape server container not running" >&2; exit 20; }

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { BrowserSession } from "./browser.js";

const CAD="https://cad.onshape.com";
const profile="/tmp/cf-d005-clean-"+process.pid;
const sensitive=(name)=>/cookie|authorization|token|secret|key|csrf|xsrf|session|code/i.test(name);
const safeQuery=(u)=>Array.from(u.searchParams.entries()).map(([k,v])=>[k,sensitive(k)?"<redacted>":String(v).slice(0,500)]);
const errShape=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,500),code:e?.code==null?null:String(e.code).slice(0,100)});

async function requestShape(response){
  const req=response.request(), u=new URL(req.url());
  const raw=await req.allHeaders().catch(()=>req.headers());
  const headers={}, sensitive_headers=[];
  for(const [name,value] of Object.entries(raw||{})){
    if(sensitive(name)) sensitive_headers.push({name,present:true,value_length:String(value??"").length});
    else headers[name]=String(value??"").slice(0,1000);
  }
  return {
    resource_type:req.resourceType(), method:req.method(), status:response.status(),
    origin:u.origin, path:u.pathname, query_entries:safeQuery(u),
    headers, sensitive_headers,
    content_type:String((await response.allHeaders().catch(()=>response.headers()))?.["content-type"]||"").slice(0,200),
  };
}
function headerNames(x){
  return [...Object.keys(x?.headers||{}),...(x?.sensitive_headers||[]).map(v=>v.name)].sort();
}
function compareRequest(natural,handcrafted){
  if(!natural||!handcrafted)return {available:false};
  const a=new Set(headerNames(natural)), b=new Set(headerNames(handcrafted));
  const natural_only=[...a].filter(x=>!b.has(x));
  const handcrafted_only=[...b].filter(x=>!a.has(x));
  const different_non_sensitive=[];
  for(const name of [...a].filter(x=>b.has(x))){
    if(Object.hasOwn(natural.headers||{},name)&&Object.hasOwn(handcrafted.headers||{},name)&&natural.headers[name]!==handcrafted.headers[name]){
      different_non_sensitive.push({name,natural:natural.headers[name],handcrafted:handcrafted.headers[name]});
    }
  }
  return {
    available:true,
    same_origin:natural.origin===handcrafted.origin,
    same_path:natural.path===handcrafted.path,
    same_query:JSON.stringify(natural.query_entries)===JSON.stringify(handcrafted.query_entries),
    natural_only_headers:natural_only,
    handcrafted_only_headers:handcrafted_only,
    different_non_sensitive_headers:different_non_sensitive,
  };
}

let session=null;
try{
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  session=new BrowserSession({
    profileDir:profile,
    accountFile:"/run/onshape-secrets/account",
    passwordFile:"/run/onshape-secrets/password",
    buildId:"d005-clean-natural-capture",
  });

  let inputRequired=null;
  const loginResult=await session.login({awaitInput:(kind)=>{inputRequired=kind;}});
  if(inputRequired){
    const out={capture:"LOGIN_INPUT_REQUIRED",input_required:inputRequired};
    console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
    process.exitCode=32;
  } else if(loginResult?.auth?.state!=="PROVEN"){
    const out={capture:"LOGIN_NOT_PROVEN",auth:{state:loginResult?.auth?.state??"UNKNOWN",request_origin:loginResult?.auth?.request_origin??null,http_status:loginResult?.auth?.http_status??null,account_id_present:!!loginResult?.auth?.account_id}};
    console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
    process.exitCode=33;
  } else {
    const page=session.page;
    const traffic=[], targets=[], failures=[], consoleErrors=[], pending=[];
    page.on("response",(resp)=>{
      const p=requestShape(resp).then(d=>{
        if(["xhr","fetch"].includes(d.resource_type)&&traffic.length<300)traffic.push(d);
        if(/globaltree|treenode/i.test(d.path)&&targets.length<40)targets.push(d);
      }).catch(()=>{});
      pending.push(p);
    });
    page.on("requestfailed",(req)=>{
      if(failures.length>=30)return;
      try{const u=new URL(req.url());failures.push({resource_type:req.resourceType(),method:req.method(),origin:u.origin,path:u.pathname,query_entries:safeQuery(u),failure:String(req.failure()?.errorText||"").slice(0,300)});}catch{}
    });
    page.on("console",(msg)=>{
      if(msg.type()!=="error"||consoleErrors.length>=30)return;
      const loc=msg.location();
      consoleErrors.push({text:msg.text().slice(0,1000),url:String(loc?.url||"").slice(0,500),line:loc?.lineNumber??null,column:loc?.columnNumber??null});
    });

    const naturalWait=page.waitForResponse(resp=>{
      try{return /globaltree|treenode/i.test(new URL(resp.url()).pathname);}catch{return false;}
    },{timeout:25000}).catch(()=>null);

    await page.goto(CAD+"/documents",{waitUntil:"domcontentloaded",timeout:45000});
    const naturalResp=await naturalWait;
    await page.waitForLoadState("networkidle",{timeout:7000}).catch(()=>null);
    await Promise.allSettled(pending);
    let natural=naturalResp?await requestShape(naturalResp):targets[0]??null;

    const handPath="/api/globaltreenodes/magic/1?getPathToRoot=true&limit=50&sortColumn=modifiedAt&sortOrder=desc";
    const handWait=page.waitForResponse(resp=>{
      try{
        const u=new URL(resp.url());
        return u.origin===CAD&&u.pathname==="/api/globaltreenodes/magic/1"&&u.searchParams.get("getPathToRoot")==="true";
      }catch{return false;}
    },{timeout:10000}).catch(()=>null);
    const handEval=page.evaluate(async({handPath})=>{
      const r=await fetch(handPath,{credentials:"include",cache:"no-store",headers:{Accept:"application/json"}});
      await r.text();
      return {status:r.status};
    },{handPath});
    const [handResp,handResult]=await Promise.all([handWait,handEval]);
    const handcrafted=handResp?await requestShape(handResp):{status:handResult.status,origin:CAD,path:"/api/globaltreenodes/magic/1",query_entries:[["getPathToRoot","true"],["limit","50"],["sortColumn","modifiedAt"],["sortOrder","desc"]],headers:{accept:"application/json"},sensitive_headers:[]};

    const auth=await session.proveAuthentication();
    const snap=await page.evaluate(()=>({href:location.href,origin:location.origin,title:document.title,ready_state:document.readyState,body_text_length:document.body?.innerText?.length??null,body_child_count:document.body?.children?.length??null}));
    const out={
      capture:natural?"TREE_REQUEST_OBSERVED":"NO_TREE_REQUEST",
      auth:{state:auth.state,request_origin:auth.request_origin,http_status:auth.http_status,account_id_present:!!auth.account_id},
      page_snapshot:snap,
      natural_request:natural,
      handcrafted_request:handcrafted,
      comparison:compareRequest(natural,handcrafted),
      xhr_fetch_count:traffic.length,
      xhr_fetch_traffic:traffic,
      failed_requests:failures,
      console_errors:consoleErrors,
    };
    console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
  }
}catch(e){
  const out={capture:"DIAGNOSTIC_FAILED",error:errShape(e)};
  console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
  process.exitCode=31;
}finally{
  if(session?.context)await session.context.close().catch(()=>{});
  fs.rmSync(profile,{recursive:true,force:true});
}
NODE
