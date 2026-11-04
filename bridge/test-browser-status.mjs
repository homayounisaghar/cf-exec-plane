import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "./worker.mjs";

const PRIMARY="https://dexa-cf-worker-canary-20261104.mirkazem.workers.dev";
const BACKUP="https://dexa-cf-backup-20261104.mirkazem-design.workers.dev";

const swResponse=await worker.fetch(new Request(PRIMARY+"/sw.js"));
assert.equal(swResponse.status,200);
const swSource=await swResponse.text();
assert.match(swSource,/DEXA_FAILOVER_STATUS_QUERY/);
assert.match(swSource,/DEXA_FAILOVER_STATUS/);
assert.match(swSource,/const BACKUP_ORIGIN = "https:/);

const root=await (await worker.fetch(new Request(PRIMARY+"/"))).text();
assert.match(root,/dexa-failover-browser-status/);
const installedScript=root.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(installedScript,"status code must appear on the root page");

function serviceWorkerHandler(script=swSource){
  const handlers={};
  const self={
    location:{origin:PRIMARY},
    clients:{claim:async()=>{},get:async()=>null},
    skipWaiting:async()=>{},
    addEventListener(name,handler){handlers[name]=handler}
  };
  vm.runInNewContext(script,{self,URL,Request,Response,fetch:async()=>new Response("ok")});
  assert.equal(typeof handlers.message,"function");
  return handlers.message;
}
const handleActive=serviceWorkerHandler();
function ask(handle){
  let result;
  handle({
    data:{type:"DEXA_FAILOVER_STATUS_QUERY"},
    ports:[{postMessage(value){result=value}}]
  });
  return result;
}
assert.equal(ask(handleActive).type,"DEXA_FAILOVER_STATUS");
assert.equal(ask(handleActive).version,"DEXA_CLOUDFLARE_BRIDGE_V1");
assert.equal(ask(handleActive).backupReady,true);
const inactiveSource=swSource.replace(
  'const BACKUP_ORIGIN = "'+BACKUP+'";',
  'const BACKUP_ORIGIN = null;'
);
assert.notEqual(inactiveSource,swSource);
const handleInactive=serviceWorkerHandler(inactiveSource);
assert.equal(ask(handleInactive).backupReady,false);

function createPage({active=true, supported=true, handler=handleActive}={}){
  const badge={style:{},dataset:{},attributes:{},
    setAttribute(k,v){this.attributes[k]=v},
    textContent:""};
  const workerListeners={};
  const nav={};
  let replaced="";
  const controller={postMessage(message,ports){handler({data:message,ports})}};
  if(supported){
    const sw={
      controller:active?controller:null,
      addEventListener(type,fn){workerListeners[type]=fn},
      register(){return Promise.resolve({})},
      ready:Promise.resolve({})
    };
    nav.serviceWorker=sw;
  }
  class FakeMessageChannel {
    constructor(){
      const port1=this.port1={onmessage:null,close(){}};
      this.port2={postMessage(data){queueMicrotask(()=>port1.onmessage?.({data}))}};
    }
  }
  const doc={body:{appendChild(node){assert.equal(node,badge)}},
    createElement(){return badge}};
  vm.runInNewContext(installedScript,{
    document:doc,navigator:nav,MessageChannel:FakeMessageChannel,
    location:{origin:PRIMARY,replace(url){replaced=url}},
    URL,setTimeout,clearTimeout,console
  });
  return {badge,workerListeners,nav,controller,
    get replaced(){return replaced}};
}

const ready=createPage();
await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(ready.badge.dataset.state,"ready");
assert.match(ready.badge.textContent,/آماده/);
assert.equal(ready.badge.attributes.role,"status");

const waiting=createPage({active:false});
await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(waiting.badge.dataset.state,"pending");
assert.notEqual(waiting.badge.dataset.state,"ready");
waiting.nav.serviceWorker.controller=waiting.controller;
waiting.workerListeners.controllerchange();
await new Promise(resolve=>setTimeout(resolve,15));
assert.equal(waiting.badge.dataset.state,"ready");

const disabled=createPage({handler:handleInactive});
await new Promise(resolve=>setTimeout(resolve,15));
assert.equal(disabled.badge.dataset.state,"off");
const unsupported=createPage({supported:false});
assert.equal(unsupported.badge.dataset.state,"off");

ready.workerListeners.message({data:{
  type:"DEXA_QUOTA_FAILOVER",
  url:BACKUP+"/dexa-lite/"
}});
assert.equal(ready.replaced,BACKUP+"/dexa-lite/");

const oldFetch=globalThis.fetch;
globalThis.fetch=async()=>new Response("<html><body>mock lite</body></html>",{
  status:200,headers:{"content-type":"text/html; charset=utf-8"}
});
try{
  const lite=await worker.fetch(new Request(PRIMARY+"/dexa-lite/"));
  assert.equal(lite.status,200);
  assert.match(await lite.text(),/dexa-failover-browser-status/);
}finally{
  globalThis.fetch=oldFetch;
}
console.log("PASS: real SW status handshake, active/pending/off UI states, controllerchange, account-B absence, quota navigation and Lite badge injection");