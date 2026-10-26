import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createOAuthBridge } from "./oauth-bridge.mjs";

const repoRoot=path.resolve(new URL("../../",import.meta.url).pathname);
const scratch=path.join(repoRoot,".oauth-offline-fixture");
const owner="cfsub_owner_a";
const resource="https://cf-onshape.duckdns.org/mcp/oauth";
const verifier="Q".repeat(64);
const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
function fixture() {
  fs.rmSync(scratch,{force:true,recursive:true});
  const state={mode:"enforce",owners:[{subject_fingerprint:owner}],organization_fingerprints:[]};
  const bridge=createOAuthBridge({stateDir:scratch,origin:"https://cf-onshape.duckdns.org",ownerState:()=>state});
  const routes=[];
  const app={
    get(paths,fn){for(const p of Array.isArray(paths)?paths:[paths])routes.push({method:"GET",p,fn});},
    post(p,fn){routes.push({method:"POST",p,fn});}
  };
  bridge.install(app);
  async function invoke(method,p,{body={},query={}}={}){
    let match=routes.find(r=>r.method===method&&r.p===p);
    let params={};
    if(!match){
      match=routes.find(r=>r.method===method&&r.p.includes("/:")&&p.startsWith(r.p.slice(0,r.p.indexOf("/:"))+"/"));
      if(match)params[match.p.split("/:")[1]]=p.slice(match.p.indexOf("/:")+p.indexOf("/")-1);
    }
    assert.ok(match,"route "+method+" "+p);
    const obj={headers:{},statusCode:200,body:null,ended:false};
    const res={
      set(k,v){if(typeof k==="object")Object.assign(obj.headers,k);else obj.headers[k]=v;return res;},
      status(v){obj.statusCode=v;return res;}, json(v){obj.body=v;return res;},
      type(v){obj.headers["Content-Type"]=v;return res;},
      send(v){obj.body=v;return res;},end(){obj.ended=true;return res;}
    };
    const req={body,query,params};
    if(match.p.includes("/:"))params.sid=p.split("/").pop();
    await match.fn(req,res);
    return obj;
  }
  return {bridge,state,invoke};
}
test("OAuth discovery advertises correct resource and public PKCE flow", async()=>{
 const {invoke}=fixture();
 const p=await invoke("GET","/.well-known/oauth-protected-resource");
 assert.equal(p.body.resource,resource);
 assert.deepEqual(p.body.authorization_servers,["https://cf-onshape.duckdns.org"]);
 const as=await invoke("GET","/.well-known/oauth-authorization-server");
 assert.equal(as.body.issuer,"https://cf-onshape.duckdns.org");
 assert.ok(as.body.code_challenge_methods_supported.includes("S256"));
 assert.ok(as.body.registration_endpoint.includes("/mcp/oauth/register"));
});
test("registration validates allowed redirect and protects authorization response",async()=>{
 const {invoke}=fixture();
 const bad=await invoke("POST","/mcp/oauth/register",{body:{redirect_uris:["http://evil.example/callback"]}});
 assert.equal(bad.statusCode,400);
 const ok=await invoke("POST","/mcp/oauth/register",{body:{redirect_uris:["https://valid.example/callback"],client_name:"<img src=x onerror=alert(1)>"}});
 assert.equal(ok.statusCode,201);
 const cid=ok.body.client_id;
 assert.ok(/^cfclient_[0-9a-f]{36}$/.test(cid));
 const query={client_id:cid,response_type:"code",redirect_uri:"https://valid.example/callback",code_challenge:challenge,code_challenge_method:"S256",resource,state:"state-request-123456"};
 const rejected=await invoke("GET","/mcp/oauth/authorize",{query:{...query,resource:"https://evil.example"}});
 assert.equal(rejected.statusCode,400);
 const ready=await invoke("GET","/mcp/oauth/authorize",{query});
 assert.equal(ready.statusCode,200);
 assert.ok(ready.body.includes("CF-"));
 assert.ok(!ready.body.includes("<img src=x onerror=alert(1)>"));
 assert.ok(ready.body.includes("&lt;img"));
 assert.equal(ready.headers["Cache-Control"],"no-store");
});
test("owner pairing, PKCE, single-use codes, refresh, revoke and owner gate",async()=>{
 const {bridge,invoke,state}=fixture();
 const reg=await invoke("POST","/mcp/oauth/register",{body:{redirect_uris:["https://valid.example/cb"],client_name:"Gemini"}});
 const client_id=reg.body.client_id;
 const query={client_id,response_type:"code",redirect_uri:"https://valid.example/cb",code_challenge:challenge,code_challenge_method:"S256",resource,state:"some-long-client-state"};
 const auth=await invoke("GET","/mcp/oauth/authorize",{query});
 const approval=auth.body.match(/CF-[0-9A-F]{12}/)[0];
 const sid=auth.body.match(/const sid="([0-9a-f]{48})"/)[1];
 assert.equal((await invoke("GET","/mcp/oauth/poll/"+sid)).body.status,"pending");
 assert.throws(()=>bridge.approve(approval,"cfsub_stranger"),/OWNER_OR_CODE_INVALID/);
 assert.equal(bridge.approve(approval,owner).approved,true);
 const poll=await invoke("GET","/mcp/oauth/poll/"+sid);
 const redirect=new URL(poll.body.redirect_url);
 const code=redirect.searchParams.get("code");
 assert.equal(redirect.searchParams.get("state"),query.state);
 const tokenBase={client_id,resource,redirect_uri:query.redirect_uri,grant_type:"authorization_code",code,code_verifier:"B".repeat(64)};
 const bad=await invoke("POST","/mcp/oauth/token",{body:tokenBase});
 assert.equal(bad.statusCode,400);
 const got=await invoke("POST","/mcp/oauth/token",{body:{...tokenBase,code_verifier:verifier}});
 assert.equal(got.statusCode,200);
 assert.equal(got.body.token_type,"Bearer");
 assert.ok(bridge.verifyBearer("Bearer "+got.body.access_token));
 assert.equal(bridge.verifyBearer("Bearer "+"f".repeat(64)),null);
 const replay=await invoke("POST","/mcp/oauth/token",{body:{...tokenBase,code_verifier:verifier}});
 assert.equal(replay.statusCode,400);
 const refreshed=await invoke("POST","/mcp/oauth/token",{body:{client_id,resource,grant_type:"refresh_token",refresh_token:got.body.refresh_token}});
 assert.equal(refreshed.statusCode,200);
 const reuse=await invoke("POST","/mcp/oauth/token",{body:{client_id,resource,grant_type:"refresh_token",refresh_token:got.body.refresh_token}});
 assert.equal(reuse.statusCode,400);
 await invoke("POST","/mcp/oauth/revoke",{body:{client_id,token:refreshed.body.access_token}});
 assert.equal(bridge.verifyBearer("Bearer "+refreshed.body.access_token),null);
 assert.ok(bridge.verifyBearer("Bearer "+got.body.access_token));
 state.mode="observe";
 assert.equal(bridge.verifyBearer("Bearer "+got.body.access_token),null);
 state.mode="enforce";state.owners=[{subject_fingerprint:owner}];
 state.organization_fingerprints=["cforg_other"];
 assert.equal(bridge.verifyBearer("Bearer "+got.body.access_token),null);
 state.organization_fingerprints=[];
 state.mode="enforce";state.owners=[];
 assert.equal(bridge.verifyBearer("Bearer "+got.body.access_token),null);
});
test("unauthenticated bearer requests return HTTP 401 challenge",()=>{
 const {bridge}=fixture();
 const data={headers:{},status:0,body:null};
 const res={
  set(k,v){data.headers[k]=v;return res;},
  status(v){data.status=v;return res;},
  json(v){data.body=v;return res;}
 };
 bridge.sendUnauthorized(res);
 assert.equal(data.status,401);
 assert.ok(data.headers["WWW-Authenticate"].includes("/.well-known/oauth-protected-resource"));
 fs.rmSync(scratch,{recursive:true,force:true});
});

test("r253 Telegram owner approval on the pairing page",async()=>{
 const calls=[];
 Object.defineProperty(globalThis,"__cfOpsCallAgent",{configurable:true,writable:true,value:async(op,args,_t,caller)=>{
   calls.push({op,args,caller});
   if(op==="server_admin_request")return {ok:true,result:{request_id:"0123456789abcdef",expires_in_s:600}};
   if(op==="server_admin_approve")return args.code==="123456"&&args.request_id==="0123456789abcdef"?{ok:true,result:{exit_code:0}}:{ok:false,error:{code:"CODE_INVALID"}};
   return {ok:false,error:{code:"UNKNOWN"}};
 }});
 const {bridge,invoke,state}=fixture();
 const reg=await invoke("POST","/mcp/oauth/register",{body:{redirect_uris:["https://www.notion.so/cb"],client_name:"Notion<script>\u202e"}});
 const client_id=reg.body.client_id;
 const query={client_id,response_type:"code",redirect_uri:"https://www.notion.so/cb",code_challenge:challenge,code_challenge_method:"S256",resource,state:"some-long-client-state"};
 const auth=await invoke("GET","/mcp/oauth/authorize",{query});
 assert.ok(auth.body.includes('id="tgsend"')&&auth.body.includes("cf_oauth_approve"));
 const approval=auth.body.match(/CF-[0-9A-F]{12}/)[0];
 const sid=auth.body.match(/const sid="([0-9a-f]{48})"/)[1];
 assert.equal((await invoke("POST","/mcp/oauth/tg-verify/"+sid,{body:{code:"123456"}})).statusCode,409);
 assert.equal((await invoke("POST","/mcp/oauth/tg-send/"+"0".repeat(48))).statusCode,404);
 const sent=await invoke("POST","/mcp/oauth/tg-send/"+sid);
 assert.equal(sent.body.sent,true);
 const rq=calls.find(c=>c.op==="server_admin_request");
 assert.equal(rq.args.command,"true"); assert.equal(rq.caller,"oauth-pairing-page");
 assert.ok(rq.args.reason.includes("Notionscript")&&rq.args.reason.includes("www.notion.so")&&!/[<>\u202e]/.test(rq.args.reason)&&!rq.args.reason.includes(approval));
 assert.equal((await invoke("POST","/mcp/oauth/tg-send/"+sid)).body.sent,true);
 assert.equal((await invoke("POST","/mcp/oauth/tg-send/"+sid)).statusCode,429);
 assert.equal((await invoke("POST","/mcp/oauth/tg-verify/"+sid,{body:{code:"12a"}})).statusCode,400);
 const wrong=await invoke("POST","/mcp/oauth/tg-verify/"+sid,{body:{code:"000000"}});
 assert.equal(wrong.statusCode,403); assert.match(wrong.body.error_description,/Wrong code\. Attempts left: 4/);
 assert.equal((await invoke("GET","/mcp/oauth/poll/"+sid)).body.status,"pending");
 const ok=await invoke("POST","/mcp/oauth/tg-verify/"+sid,{body:{code:"123 456"}});
 assert.equal(ok.body.approved,true);
 const poll=await invoke("GET","/mcp/oauth/poll/"+sid);
 const code=new URL(poll.body.redirect_url).searchParams.get("code");
 const tok=await invoke("POST","/mcp/oauth/token",{body:{client_id,resource,redirect_uri:query.redirect_uri,grant_type:"authorization_code",code,code_verifier:verifier}});
 assert.equal(tok.statusCode,200);
 assert.equal(bridge.verifyBearer("Bearer "+tok.body.access_token).owner,owner);
 assert.equal((await invoke("POST","/mcp/oauth/tg-verify/"+sid,{body:{code:"123456"}})).statusCode,404);
 // five wrong codes lock the session
 const a2=await invoke("GET","/mcp/oauth/authorize",{query});
 const sid2=a2.body.match(/const sid="([0-9a-f]{48})"/)[1];
 await invoke("POST","/mcp/oauth/tg-send/"+sid2);
 for(let i=0;i<5;i++)assert.equal((await invoke("POST","/mcp/oauth/tg-verify/"+sid2,{body:{code:"999999"}})).statusCode,403);
 assert.equal((await invoke("POST","/mcp/oauth/tg-verify/"+sid2,{body:{code:"123456"}})).statusCode,429);
 // hourly cap: 3 sends so far, the 4th works, the 5th is refused
 const a3=await invoke("GET","/mcp/oauth/authorize",{query});
 const sid3=a3.body.match(/const sid="([0-9a-f]{48})"/)[1];
 assert.equal((await invoke("POST","/mcp/oauth/tg-send/"+sid3)).body.sent,true);
 const a4=await invoke("GET","/mcp/oauth/authorize",{query});
 const sid4=a4.body.match(/const sid="([0-9a-f]{48})"/)[1];
 const capped=await invoke("POST","/mcp/oauth/tg-send/"+sid4);
 assert.equal(capped.statusCode,429); assert.match(capped.body.error_description,/this hour/);
 state.owners=[];
 assert.ok([429,503].includes((await invoke("POST","/mcp/oauth/tg-send/"+sid4)).statusCode));
 delete globalThis.__cfOpsCallAgent;
});

test("r253 Telegram approval refuses without agent or owner",async()=>{
 const {invoke,state}=fixture();
 const reg=await invoke("POST","/mcp/oauth/register",{body:{redirect_uris:["https://valid.example/cb"],client_name:"X"}});
 const query={client_id:reg.body.client_id,response_type:"code",redirect_uri:"https://valid.example/cb",code_challenge:challenge,code_challenge_method:"S256",resource,state:"some-long-client-state"};
 const sid=(await invoke("GET","/mcp/oauth/authorize",{query})).body.match(/const sid="([0-9a-f]{48})"/)[1];
 delete globalThis.__cfOpsCallAgent;
 const r=await invoke("POST","/mcp/oauth/tg-send/"+sid);
 assert.ok([429,503].includes(r.statusCode));
});
