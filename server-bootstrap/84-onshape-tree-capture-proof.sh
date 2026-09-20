#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "must run as uid 0" >&2; exit 1; }

source_profile="/var/lib/capability-fabric/onshape/browser-profile"
container="capability-fabric-onshape-server"
host_clone="$(mktemp -d /var/lib/capability-fabric/onshape/.d005-profile-clone.XXXXXX)"
cleanup() {
  docker exec "$container" rm -rf /tmp/cf-d005-profile >/dev/null 2>&1 || true
  rm -rf "$host_clone"
}
trap cleanup EXIT

[[ -d "$source_profile" ]] || { echo "Onshape profile missing" >&2; exit 20; }
docker inspect "$container" >/dev/null 2>&1 || { echo "Onshape server container missing" >&2; exit 20; }
[[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "Onshape server container not running" >&2; exit 20; }

# D-005 requires evidence before any 401 remediation. Work only on a temporary
# local copy; never alter or delete the persistent profile.
cp -a "$source_profile/." "$host_clone/"
rm -f "$host_clone/.backup-exclusion-sentinel"
rm -rf "$host_clone/log"
find "$host_clone" -maxdepth 2 \( -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' -o -name 'DevToolsActivePort' \) -exec rm -rf {} + 2>/dev/null || true

docker exec "$container" rm -rf /tmp/cf-d005-profile
tar -C "$host_clone" -cf - . | docker exec -i "$container" sh -lc 'mkdir -p /tmp/cf-d005-profile && tar --no-same-owner -C /tmp/cf-d005-profile -xf - && chown -R 0:0 /tmp/cf-d005-profile'

docker exec -i "$container" sh -lc 'cd /tmp/app && node --input-type=module' <<'NODE'
import { chromium } from "playwright";

const PROFILE="/tmp/cf-d005-profile";
const CAD="https://cad.onshape.com";
const sensitive=(name)=>/cookie|authorization|token|secret|key|csrf|xsrf|session|code/i.test(name);
const safeEntries=(u)=>Array.from(u.searchParams.entries()).map(([k,v])=>[k,sensitive(k)?"<redacted>":String(v).slice(0,500)]);
const shapeError=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,500),code:e?.code==null?null:String(e.code).slice(0,80)});
const traffic=[], targets=[], consoleErrors=[], pageErrors=[], failed=[], pending=[];

async function describe(response){
  const req=response.request();
  const u=new URL(req.url());
  const raw=await req.allHeaders().catch(()=>req.headers());
  const headers={}, sensitive_headers=[];
  for(const [name,value] of Object.entries(raw||{})){
    if(sensitive(name)) sensitive_headers.push({name,present:true,value_length:String(value??"").length});
    else headers[name]=String(value??"").slice(0,1000);
  }
  return {
    resource_type:req.resourceType(),
    method:req.method(),
    status:response.status(),
    origin:u.origin,
    path:u.pathname,
    query_entries:safeEntries(u),
    headers,
    sensitive_headers,
    content_type:String((await response.allHeaders().catch(()=>response.headers()))?.["content-type"]||"").slice(0,200),
  };
}

let context=null;
try{
  context=await chromium.launchPersistentContext(PROFILE,{
    headless:true,
    chromiumSandbox:false,
    args:["--no-sandbox","--disable-dev-shm-usage"],
    viewport:{width:1440,height:1000},
  });
  const page=context.pages()[0] || await context.newPage();
  page.on("response",(resp)=>{
    const p=describe(resp).then((d)=>{
      if(["xhr","fetch"].includes(d.resource_type) && traffic.length<250) traffic.push(d);
      if(/globaltree|treenode/i.test(d.path) && targets.length<30) targets.push(d);
    }).catch(()=>{});
    pending.push(p);
  });
  page.on("console",(msg)=>{
    if(msg.type()!=="error" || consoleErrors.length>=30) return;
    const loc=msg.location();
    consoleErrors.push({text:msg.text().slice(0,1000),url:String(loc?.url||"").slice(0,500),line:loc?.lineNumber??null,column:loc?.columnNumber??null});
  });
  page.on("pageerror",(e)=>{if(pageErrors.length<20)pageErrors.push(shapeError(e));});
  page.on("requestfailed",(req)=>{
    if(failed.length>=30)return;
    try{const u=new URL(req.url());failed.push({method:req.method(),resource_type:req.resourceType(),origin:u.origin,path:u.pathname,query_entries:safeEntries(u),failure:String(req.failure()?.errorText||"").slice(0,300)});}catch{}
  });

  const targetWait=page.waitForResponse((resp)=>{
    try{return /globaltree|treenode/i.test(new URL(resp.url()).pathname);}catch{return false;}
  },{timeout:20000}).catch(()=>null);

  const navError=await page.goto(CAD+"/documents",{waitUntil:"domcontentloaded",timeout:45000}).then(()=>null).catch(shapeError);
  const naturalTarget=await targetWait;
  await page.waitForLoadState("networkidle",{timeout:5000}).catch(()=>null);
  await Promise.allSettled(pending);

  const storage=await page.evaluate(async()=>{
    const shape=(e)=>({name:String(e?.name||"Error").slice(0,120),message:String(e?.message||"error").slice(0,400),code:e?.code==null?null:String(e.code).slice(0,80)});
    const r={estimate:null,indexeddb:null,local_storage:null,session_storage:null};
    try{const e=await navigator.storage.estimate();r.estimate={ok:true,usage:Number(e.usage||0),quota:Number(e.quota||0)}}catch(e){r.estimate={ok:false,error:shape(e)}}
    try{const d=await indexedDB.databases();r.indexeddb={ok:true,count:d.length,names:d.map(x=>String(x?.name||"").slice(0,120)).filter(Boolean).slice(0,40)}}catch(e){r.indexeddb={ok:false,error:shape(e)}}
    try{r.local_storage={ok:true,length:localStorage.length}}catch(e){r.local_storage={ok:false,error:shape(e)}}
    try{r.session_storage={ok:true,length:sessionStorage.length}}catch(e){r.session_storage={ok:false,error:shape(e)}}
    return r;
  }).catch(e=>({outer_error:shapeError(e)}));

  const snapshot=await page.evaluate(()=>({
    href:location.href,origin:location.origin,title:document.title,ready_state:document.readyState,
    body_text_length:document.body?.innerText?.length??null,body_child_count:document.body?.children?.length??null,
    script_count:document.scripts?.length??null,iframe_count:document.querySelectorAll("iframe").length,
  })).catch(e=>({error:shapeError(e)}));

  const cookies=(await context.cookies(CAD)).map(c=>({name:c.name,domain:c.domain,path:c.path,secure:c.secure,sameSite:c.sameSite}));

  console.log("CF_ONSHAPE_D005_CLONE_CAPTURE="+JSON.stringify({
    capture:naturalTarget?"TREE_REQUEST_OBSERVED":"NO_TREE_REQUEST",
    page_snapshot:snapshot,
    navigation_error:navError,
    storage,
    cookie_metadata_without_values:cookies,
    xhr_fetch_count:traffic.length,
    xhr_fetch_traffic:traffic,
    target_request_count:targets.length,
    target_requests:targets,
    console_errors:consoleErrors,
    page_errors:pageErrors,
    failed_requests:failed,
  }));
} catch(e){
  console.log("CF_ONSHAPE_D005_CLONE_CAPTURE="+JSON.stringify({capture:"DIAGNOSTIC_FAILED",error:shapeError(e)}));
  process.exitCode=31;
} finally {
  if(context) await context.close().catch(()=>{});
}
NODE
