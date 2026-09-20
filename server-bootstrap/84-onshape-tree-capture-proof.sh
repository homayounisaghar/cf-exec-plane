#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }
container="capability-fabric-onshape-server"
docker inspect "$container" >/dev/null 2>&1 || { echo "Onshape server container missing" >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "Onshape server container not running" >&2; exit 20; }

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import fs from "node:fs";
import { chromium } from "playwright";

const CAD="https://cad.onshape.com";
const profile="/tmp/cf-d005-clean-"+process.pid;
const account=fs.readFileSync("/run/onshape-secrets/account","utf8");
const password=fs.readFileSync("/run/onshape-secrets/password","utf8");
const sensitive=(name)=>/cookie|authorization|token|secret|key|csrf|xsrf|session|code/i.test(name);
const safeQuery=(u)=>Array.from(u.searchParams.entries()).map(([k,v])=>[k,sensitive(k)?"<redacted>":String(v).slice(0,500)]);
const errShape=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,500),code:e?.code==null?null:String(e.code).slice(0,100)});
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));

async function firstVisible(page,selectors){
  for(const selector of selectors){
    const loc=page.locator(selector).first();
    try{if(await loc.isVisible({timeout:250}))return loc;}catch{}
  }
  return null;
}
async function authProbe(page){
  try{
    return await page.evaluate(async()=>{
      const u=new URL("/api/users/current",location.origin);
      const r=await fetch(u.pathname,{credentials:"include",cache:"no-store",headers:{Accept:"application/json"}});
      const text=await r.text(); let d=null; try{d=JSON.parse(text)}catch{}
      const id=d?.id??d?.userId??d?.user?.id??d?.user?.userId??d?.currentUser?.id??null;
      return {state:(r.status===401||r.status===403)?"REJECTED":(r.ok&&id)?"PROVEN":"UNKNOWN",http_status:r.status,request_origin:u.origin,account_id_present:!!id};
    });
  }catch(e){return {state:"UNKNOWN",http_status:null,request_origin:null,account_id_present:false,error:errShape(e)}}
}
async function currentChallenge(page){
  const verification=await firstVisible(page,['input[autocomplete="one-time-code"]','input[name*="code" i]','input[id*="code" i]','input[type="tel"]']);
  if(verification)return "EMAIL_VERIFICATION_CODE";
  const body=await page.locator("body").innerText().catch(()=>"");
  if(/captcha|recaptcha|robot/i.test(body))return "INTERACTIVE_CHALLENGE";
  if(/approve.*device|device.*approval|verify.*identity|confirm.*identity/i.test(body))return "DEVICE_OR_IDENTITY_CHALLENGE";
  return null;
}
async function login(page){
  await page.goto(CAD+"/signin",{waitUntil:"domcontentloaded",timeout:45000});
  let emailDone=false,passwordDone=false;
  for(let step=0;step<45;step++){
    const auth=await authProbe(page);
    if(auth.state==="PROVEN")return {ok:true,auth};
    const challenge=await currentChallenge(page);
    if(challenge)return {ok:false,challenge,auth};

    const email=await firstVisible(page,['input[type="email"]','input[autocomplete="username"]','input[name*="email" i]','input[id*="email" i]']);
    const pass=await firstVisible(page,['input[type="password"]','input[autocomplete="current-password"]','input[name*="password" i]']);

    if(email&&!emailDone){
      await email.fill("");
      await email.pressSequentially(account,{delay:10});
      emailDone=true;
      const continueBtn=page.locator('button.continue-button, button:has-text("Continue"), button:has-text("Next")').filter({visible:true}).first();
      let enabled=false;
      for(let i=0;i<20;i++){try{enabled=await continueBtn.isEnabled({timeout:100});}catch{} if(enabled)break; await pause(100);}
      if(enabled)await continueBtn.click(); else await email.press("Enter");
      await page.waitForLoadState("domcontentloaded",{timeout:5000}).catch(()=>null);
      await pause(500);
      continue;
    }
    if(pass&&!passwordDone){
      await pass.fill("");
      await pass.pressSequentially(password,{delay:10});
      passwordDone=true;
      const submit=await firstVisible(page,['button[type="submit"]:not([disabled])','button:has-text("Sign in"):not([disabled])','button:has-text("Log in"):not([disabled])','button:has-text("Continue"):not([disabled])']);
      if(submit)await submit.click(); else await pass.press("Enter");
      await page.waitForLoadState("domcontentloaded",{timeout:7000}).catch(()=>null);
      await pause(800);
      continue;
    }
    await pause(500);
  }
  return {ok:false,challenge:"LOGIN_UNRESOLVED",auth:await authProbe(page)};
}
async function requestShape(response){
  const req=response.request(), u=new URL(req.url());
  const raw=await req.allHeaders().catch(()=>req.headers());
  const headers={}, sensitive_headers=[];
  for(const [name,value] of Object.entries(raw||{})){
    if(sensitive(name))sensitive_headers.push({name,present:true,value_length:String(value??"").length});
    else headers[name]=String(value??"").slice(0,1000);
  }
  return {resource_type:req.resourceType(),method:req.method(),status:response.status(),origin:u.origin,path:u.pathname,query_entries:safeQuery(u),headers,sensitive_headers,content_type:String((await response.allHeaders().catch(()=>response.headers()))?.["content-type"]||"").slice(0,200)};
}
function headerNames(x){return [...Object.keys(x?.headers||{}),...(x?.sensitive_headers||[]).map(v=>v.name)].sort();}
function collectNamed(value,wanted,out,path="$",depth=0){
  if(depth>12||value==null)return;
  if(Array.isArray(value)){for(let i=0;i<value.length;i++)collectNamed(value[i],wanted,out,path+"["+i+"]",depth+1);return;}
  if(typeof value!=="object")return;
  const label=value.name??value.displayName??value.title??null;
  if(label===wanted){
    const keep={};
    for(const k of ["id","nodeId","resourceId","parentId","resourceType","objectType","type","name","displayName","title"]){
      const v=value[k];
      if(v==null||["string","number","boolean"].includes(typeof v))keep[k]=v??null;
    }
    out.push({json_path:path,value:keep});
  }
  for(const [k,v] of Object.entries(value))collectNamed(v,wanted,out,path+"."+k,depth+1);
}
function compareRequest(a,b){
  if(!a||!b)return {available:false};
  const A=new Set(headerNames(a)),B=new Set(headerNames(b)),diff=[];
  for(const n of [...A].filter(n=>B.has(n)))if(Object.hasOwn(a.headers||{},n)&&Object.hasOwn(b.headers||{},n)&&a.headers[n]!==b.headers[n])diff.push({name:n,natural:a.headers[n],handcrafted:b.headers[n]});
  return {available:true,same_origin:a.origin===b.origin,same_path:a.path===b.path,same_query:JSON.stringify(a.query_entries)===JSON.stringify(b.query_entries),natural_only_headers:[...A].filter(n=>!B.has(n)),handcrafted_only_headers:[...B].filter(n=>!A.has(n)),different_non_sensitive_headers:diff};
}

let context=null;
try{
  fs.rmSync(profile,{recursive:true,force:true});
  context=await chromium.launchPersistentContext(profile,{headless:true,chromiumSandbox:false,viewport:{width:1440,height:1000},args:["--no-sandbox","--disable-dev-shm-usage"]});
  const page=context.pages()[0]||await context.newPage();
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(45000);

  const logged=await login(page);
  if(!logged.ok){
    const out={capture:"LOGIN_NOT_READY",challenge:logged.challenge,auth:logged.auth};
    console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
    process.exitCode=32;
  }else{
    const traffic=[],targets=[],treeMatches=[],failed=[],consoleErrors=[],pending=[];
    page.on("response",(resp)=>{const p=requestShape(resp).then(async d=>{if(["xhr","fetch"].includes(d.resource_type)&&traffic.length<300)traffic.push(d);if(/globaltree|treenode/i.test(d.path)&&targets.length<40){targets.push(d);const body=await resp.text().catch(()=>null);if(body){try{const parsed=JSON.parse(body),found=[];collectNamed(parsed,"View:TOP",found);for(const match of found.slice(0,20))treeMatches.push({request:{status:d.status,origin:d.origin,path:d.path,query_entries:d.query_entries},match})}catch{}}}}).catch(()=>{});pending.push(p);});
    page.on("requestfailed",(req)=>{if(failed.length>=30)return;try{const u=new URL(req.url());failed.push({resource_type:req.resourceType(),method:req.method(),origin:u.origin,path:u.pathname,query_entries:safeQuery(u),failure:String(req.failure()?.errorText||"").slice(0,300)})}catch{}});
    page.on("console",(msg)=>{if(msg.type()!=="error"||consoleErrors.length>=30)return;const loc=msg.location();consoleErrors.push({text:msg.text().slice(0,1000),url:String(loc?.url||"").slice(0,500),line:loc?.lineNumber??null,column:loc?.columnNumber??null})});

    const naturalWait=page.waitForResponse(resp=>{try{return /globaltree|treenode/i.test(new URL(resp.url()).pathname)}catch{return false}},{timeout:25000}).catch(()=>null);
    await page.goto(CAD+"/documents",{waitUntil:"domcontentloaded",timeout:45000});
    const naturalResp=await naturalWait;
    await page.waitForLoadState("networkidle",{timeout:7000}).catch(()=>null);
    await Promise.allSettled(pending);
    const natural=naturalResp?await requestShape(naturalResp):targets[0]??null;

    const handPath="/api/globaltreenodes/magic/1?getPathToRoot=true&limit=50&sortColumn=modifiedAt&sortOrder=desc";
    const handWait=page.waitForResponse(resp=>{try{const u=new URL(resp.url());return u.origin===CAD&&u.pathname==="/api/globaltreenodes/magic/1"&&u.searchParams.get("getPathToRoot")==="true"}catch{return false}},{timeout:10000}).catch(()=>null);
    const handEval=page.evaluate(async({handPath})=>{const r=await fetch(handPath,{credentials:"include",cache:"no-store",headers:{Accept:"application/json"}});await r.text();return {status:r.status}},{handPath});
    const [handResp,handResult]=await Promise.all([handWait,handEval]);
    const handcrafted=handResp?await requestShape(handResp):{status:handResult.status,origin:CAD,path:"/api/globaltreenodes/magic/1",query_entries:[["getPathToRoot","true"],["limit","50"],["sortColumn","modifiedAt"],["sortOrder","desc"]],headers:{accept:"application/json"},sensitive_headers:[]};

    const auth=await authProbe(page);
    const snap=await page.evaluate(()=>({href:location.href,origin:location.origin,title:document.title,ready_state:document.readyState,body_text_length:document.body?.innerText?.length??null,body_child_count:document.body?.children?.length??null}));
    const comparison=compareRequest(natural,handcrafted);
    const out={capture:natural?"TREE_REQUEST_OBSERVED":"NO_TREE_REQUEST",auth,page_snapshot:snap,natural_request:natural,handcrafted_request:handcrafted,comparison,tree_exact_matches:treeMatches,xhr_fetch_count:traffic.length,xhr_fetch_traffic:traffic,failed_requests:failed,console_errors:consoleErrors};
    const folderIds=[...new Set(treeMatches.flatMap((x)=>{const v=x?.match?.value||{};return [v.id,v.nodeId,v.resourceId].filter((y)=>y!=null&&String(y).length>0).map(String)}))];
    console.log("CF_ONSHAPE_D005_CAPTURE="+out.capture);
    console.log("CF_ONSHAPE_D005_AUTH="+String(auth?.state||"UNKNOWN"));
    console.log("CF_ONSHAPE_D005_NATURAL="+String(natural?.status??"null")+" "+String(natural?.origin||"null")+String(natural?.path||"null"));
    console.log("CF_ONSHAPE_D005_HANDCRAFTED="+String(handcrafted?.status??"null")+" "+String(handcrafted?.origin||"null")+String(handcrafted?.path||"null"));
    console.log("CF_ONSHAPE_D005_SAME_ORIGIN="+String(comparison?.same_origin??false));
    console.log("CF_ONSHAPE_D005_SAME_PATH="+String(comparison?.same_path??false));
    console.log("CF_ONSHAPE_D005_SAME_QUERY="+String(comparison?.same_query??false));
    console.log("CF_ONSHAPE_D005_NATURAL_ONLY_HEADERS="+(comparison?.natural_only_headers||[]).join(","));
    console.log("CF_ONSHAPE_D005_HANDCRAFTED_ONLY_HEADERS="+(comparison?.handcrafted_only_headers||[]).join(","));
    console.log("CF_ONSHAPE_D006_MATCH_COUNT="+treeMatches.length);
    console.log("CF_ONSHAPE_D006_FOLDER_IDS="+folderIds.join(","));
    console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify(out)).toString("base64"));
  }
}catch(e){
  console.log("CF_ONSHAPE_D005_CAPTURE_B64="+Buffer.from(JSON.stringify({capture:"DIAGNOSTIC_FAILED",error:errShape(e)})).toString("base64"));
  process.exitCode=31;
}finally{
  if(context)await context.close().catch(()=>{});
  fs.rmSync(profile,{recursive:true,force:true});
}
NODE
