import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
const hash=p=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function one(s,old,replacement){if(s.split(old).length!==2)throw Error("MARKER_MISMATCH: "+old.slice(0,50));return s.replace(old,replacement);}
export function stage({sourceDir,destDir,sequence,releaseId}) {
 if(fs.existsSync(destDir))throw Error("TARGET_EXISTS");
 fs.cpSync(sourceDir,destDir,{recursive:true});
 fs.copyFileSync(new URL("./cf-owner-auth/oauth-bridge.mjs",import.meta.url),path.join(destDir,"oauth-bridge.mjs"));
 const sf=path.join(destDir,"server.js");let s=fs.readFileSync(sf,"utf8");
 const middleware=[
  ['import { createOwnerAuthGate, registerOwnerAuthTools } from "./owner-auth.mjs";','import { createOAuthBridge } from "./oauth-bridge.mjs";'],
  ['const ownerAuth = createOwnerAuthGate({ stateDir: AGENT_STATE_DIR + "/owner-auth", buildId: BUILD_ID });',
   'const cfOAuth = createOAuthBridge({stateDir:AGENT_STATE_DIR+"/oauth",origin:"https://cf-onshape.duckdns.org",ownerState:ownerAuth.readState});'],
  ['registerOwnerAuthTools(server, z, ownerAuth, safeTool);',
   [
    'server.registerTool("cf_oauth_approve",{title:"Approve external OAuth pairing",',
    'description:"Approve a one-time OAuth pairing code from the authorization screen. Authorized ChatGPT owners only.",',
    'inputSchema:{code:z.string().regex(/^CF-[0-9A-F]{12}$/)},',
    'annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},',
    'async ({code},{_meta})=>safeTool("authorization",async()=>{',
    ' const caller=await ownerAuth.status(_meta);',
    ' if(!caller.caller.is_owner||!caller.caller.organization_allowed)throw new Error("CF_OAUTH_OWNER_REQUIRED");',
    ' return cfOAuth.approve(code,caller.caller.subject_fingerprint);',
    '}));'].join("\n")],
  ['app.use(express.json({ limit: "5mb" }));',
   [
    'app.use(express.urlencoded({extended:false,limit:"32kb"}));',
    'cfOAuth.install(app);',
    'app.post("/mcp/oauth",(req,res,next)=>{',
    ' if(!cfOAuth.verifyBearer(req.get("authorization"))){cfOAuth.sendUnauthorized(res);return;}',
    ' req.cfOAuthAuthorized=true;req.url="/mcp/"+MCP_TOKEN;next();',
    '});'].join("\n")],
  ['  const decision = ownerAuth.authorizeToolCall(req.body);',
   '  const decision = req.cfOAuthAuthorized ? {allowed:true,mode:"oauth-verified"} : ownerAuth.authorizeToolCall(req.body);']
 ];
 const patchBlock=middleware.map(([needle,add],i)=>'source=source.replace('+JSON.stringify(needle)+','+
   (i===4?JSON.stringify(add):JSON.stringify(needle+"\n"+add))+');').join("\n");
 const targetNeedle='const target = "/tmp/app/server.base.mjs";';
 s=one(s,targetNeedle,patchBlock+"\n"+targetNeedle);
 fs.writeFileSync(sf,s);
 const gf=path.join(destDir,"gateway.js");let g=fs.readFileSync(gf,"utf8");
 const mcpNeedle='const mcpPath = '+String.fromCharCode(96)+'/mcp/$'+'{token}'+String.fromCharCode(96)+';';
 const oauthDefinition='const oauthPaths=new Set(["/mcp/oauth","/mcp/oauth/authorize","/mcp/oauth/register","/mcp/oauth/token","/mcp/oauth/revoke","/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp/oauth","/.well-known/oauth-authorization-server"]);';
 const gm=[
 '  if (oauthPaths.has(pathname)||/^\\/mcp\\/oauth\\/poll\\/[0-9a-f]{48}$/.test(pathname)) {',
 '    const expected=["/mcp/oauth","/mcp/oauth/register","/mcp/oauth/token","/mcp/oauth/revoke"].includes(pathname)?"POST":"GET";',
 '    if(req.method!==expected){res.writeHead(405,{"content-type":"application/json"});res.end(JSON.stringify({error:"Method not allowed"}));return;}',
 '  } else if (pathname === mcpPath) {'].join("\n");
 const gatewayEnd='await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));';
 g=one(g,gatewayEnd,'source=source.replace('+JSON.stringify(mcpNeedle)+','+JSON.stringify(mcpNeedle+'\n'+oauthDefinition)+');\nsource=source.replace('+JSON.stringify('  if (pathname === mcpPath) {')+','+JSON.stringify(gm)+');\n'+gatewayEnd);
 fs.writeFileSync(gf,g);
 const cf=path.join(destDir,"compose.yaml");let c=fs.readFileSync(cf,"utf8");
 c=one(c,"/release/owner-auth.mjs /release/wechat-ingress.mjs","/release/owner-auth.mjs /release/oauth-bridge.mjs /release/wechat-ingress.mjs");
 fs.writeFileSync(cf,c);
 const cl=path.join(destDir,"release-closure.json"),ml=path.join(destDir,"manifest.json");
 const closure=JSON.parse(fs.readFileSync(cl,"utf8"));closure.build_id=releaseId;
 closure.files=[...new Set([...closure.files,"oauth-bridge.mjs"])].sort();
 fs.writeFileSync(cl,JSON.stringify(closure,null,2)+"\n");
 const manifest=JSON.parse(fs.readFileSync(ml,"utf8"));manifest.sequence=sequence;manifest.release_id=releaseId;
 manifest.files=Object.fromEntries([...new Set([...Object.keys(manifest.files),"oauth-bridge.mjs"])].sort().map(n=>[n,hash(path.join(destDir,n))]));
 fs.writeFileSync(ml,JSON.stringify(manifest,null,2)+"\n");
 return {sequence,releaseId,destDir};
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const [sourceDir,destDir,sequence,releaseId]=process.argv.slice(2);
 console.log(stage({sourceDir,destDir,sequence:Number(sequence),releaseId}));
}
