import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "./worker.mjs";
const PRIMARY="https://primary.example";
const BACKUP="https://backup.example";
const fake=(status,body,headers={"content-type":"text/html"})=>new Response(body,{status,headers});
async function makeSw(withBackup=true) {
  const response=await worker.fetch(new Request(PRIMARY+"/sw.js"));
  assert.equal(response.status,200);
  const source=(await response.text()).replace(/^const BACKUP_ORIGIN = .*;$/m,"const BACKUP_ORIGIN = "+JSON.stringify(withBackup?BACKUP:null)+";");
  const handlers={};
  const sent=[];
  let nextResponse,requests=0;
  const clients={ claim(){return Promise.resolve()},get:async()=>({postMessage(x){sent.push(x)}})};
  const self={location:{origin:PRIMARY},clients,skipWaiting(){return Promise.resolve()},addEventListener(name,fn){handlers[name]=fn}};
  const context={self,Response,Request,URL,console,fetch:async()=>{requests++;if(nextResponse instanceof Error)throw nextResponse;return nextResponse}};
  vm.runInNewContext(source,context,{filename:"sw.js"});
  async function dispatch(method,mode,path,response) {
    nextResponse=response;
    let p;
    const req={method,mode,url:PRIMARY+path};
    const event={request:req,clientId:"client-1",respondWith(promise){p=promise}};
    handlers.fetch(event);
    assert.ok(p);
    return await p;
  }
  return {dispatch,sent,requests:()=>requests};
}
const quota=fake(500,"<html><title>Error 1027</title>Worker exceeded free tier daily request limit.</html>");
const liveConfig=await (await worker.fetch(new Request(PRIMARY+"/bridge-health"))).json();
assert.equal(liveConfig.backupReady,true); // Primary build must have account B configured.
const tests=await makeSw(true);
const a=await tests.dispatch("GET","navigate","/dexa-lite/?status=1",quota);
assert.equal(a.status,302);
assert.equal(a.headers.get("location"),BACKUP+"/dexa-lite/?status=1");
assert.equal(tests.requests(),1);
const miss=await tests.dispatch("POST","cors","/dexa-lite/api/missions",quota);
assert.equal(miss.status,503);
assert.equal(tests.requests(),2); // NEVER replay mission submission.
assert.equal(tests.sent.length,1);
assert.equal(tests.sent[0].type,"DEXA_QUOTA_FAILOVER");
assert.equal(tests.sent[0].url,BACKUP+"/dexa-lite/");
const notQuota=await tests.dispatch("GET","navigate","/dexa-lite/",fake(500,"Worker error 1102"));
assert.equal(notQuota.status,500); // Do not mistakenly fail over for CPU limit.
const unauthorized=await tests.dispatch("GET","navigate","/dexa-lite/",fake(401,"Basic login denied"));
assert.equal(unauthorized.status,401);
const healthy=await tests.dispatch("GET","navigate","/dexa-lite/",fake(200,"Error 1027 is mentioned in ordinary page"));
assert.equal(healthy.status,200);
const network=await tests.dispatch("POST","cors","/dexa-lite/api/missions",new Error("net down"));
assert.equal(network.type,"error"); // Ambiguous outcome: NO automatic POST retry.
const noBackup=await makeSw(false);
const noBackupRes=await noBackup.dispatch("GET","navigate","/dexa-lite/",quota);
assert.equal(noBackupRes.status,500);
const badOrigin=await worker.fetch(new Request("https://primary.example/dexa-lite/api/missions",{method:"POST",headers:{"Origin":"https://malicious.example"}}));
assert.equal(badOrigin.status,403);
const noOpenProxy=await worker.fetch(new Request("https://primary.example/some-private-path"));
assert.equal(noOpenProxy.status,404);
console.log("PASS 9 FAILOVER SAFETY CASES: NAVIGATION_QUOTA_1027, POST_NO_REPLAY, MESSAGE, OTHER_ERROR, AUTH, HEALTHY, NETWORK_AMBIGUITY, NO_BACKUP, PATH_CSRF");