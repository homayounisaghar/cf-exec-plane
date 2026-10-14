import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const snapshot=path.resolve(process.argv[2]||"");
if(!fs.existsSync(path.join(snapshot,"manifest.json")))throw Error("SNAPSHOT_REQUIRED");
const work=fs.mkdtempSync(path.join(process.cwd(),".cf-oauth-render-"));
function run(args){
 const r=spawnSync(process.execPath,args,{cwd:work,encoding:"utf8",timeout:45000});
 if(r.status!==0)throw Error("OFFLINE_RENDER_FAILED: "+args.join(" ")+"\n"+r.stderr+"\n"+r.stdout);
}
try {
 for(const name of ["server","gateway"]){
   let wrapper=fs.readFileSync(path.join(snapshot,name+".js"),"utf8");
   const tail=name==="server"
      ? 'const target = "/tmp/app/server.base.mjs";\nfs.writeFileSync(target, source, { mode: 0o600 });\nawait import("./server.base.mjs");'
      : 'await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));';
   assert.ok(wrapper.includes(tail),name+" dynamic wrapper marker");
   const filename=path.join(work,name+"-effective.mjs");
   wrapper=wrapper.replace(tail,"fs.writeFileSync("+JSON.stringify(filename)+",source);");
   if(name==="gateway") wrapper='import fs from "node:fs";\n'+wrapper;
   const runner=path.join(work,name+"-offline-wrapper.mjs");
   fs.writeFileSync(runner,wrapper);
   run([runner]);
   run(["--check",filename]);
 }
 const server=fs.readFileSync(path.join(work,"server-effective.mjs"),"utf8");
 const gateway=fs.readFileSync(path.join(work,"gateway-effective.mjs"),"utf8");
 for(const marker of [
  'import { createOAuthBridge } from "./oauth-bridge.mjs";',
  'const cfOAuth = createOAuthBridge({',
  'server.registerTool("cf_oauth_approve"',
  'cfOAuth.install(app);',
  'cfOAuth.verifyBearer(req.get("authorization"))',
  'const decision = req.cfOAuthAuthorized ? {allowed:true,mode:"oauth-verified"} : ownerAuth.authorizeToolCall(req.body);',
  'const cfMcpHandle = async (req, res) => {',
  'app.post("/mcp/oauth", cfMcpHandle);'
 ])assert.ok(server.includes(marker),"Missing effective server marker: "+marker);
 assert.ok(server.indexOf("cfOAuth.verifyBearer") < server.indexOf("ownerAuth.authorizeToolCall(req.body)"),"OAuth must validate before owner gate");
 for(const marker of ['const oauthPaths=new Set(', 'oauthPaths.has(pathname)', 'pathname === mcpPath'])assert.ok(gateway.includes(marker),"Missing gateway route marker: "+marker);
 assert.ok(gateway.includes('"/.well-known/oauth-authorization-server"'),"OAuth metadata route missing");
 console.log("CF_OAUTH_EFFECTIVE_SOURCE=PASS: signed base hashes, syntax, auth ordering, proxy routing");
}finally {
 fs.rmSync(work,{force:true,recursive:true});
}
