import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "cf.oauth-owner-pair.v1";
const APPROVAL_RE = /^CF-[0-9A-F]{12}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_MS = 10 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const hex = n => crypto.randomBytes(n).toString("hex");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const challengeFor = value => crypto.createHash("sha256").update(value).digest("base64url");
const html = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
function err(res, code, message, status=400) {
  res.set("Cache-Control", "no-store").status(status).json({error:code,error_description:message});
}
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    return !u.username && !u.password && !u.hash && (u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(u.hostname)));
  } catch { return false; }
}
export function createOAuthBridge({stateDir, origin, ownerState}) {
  if (!path.isAbsolute(stateDir) || typeof ownerState !== "function") throw Error("CF_OAUTH_CONFIG_INVALID");
  const publicOrigin = new URL(origin);
  if (publicOrigin.protocol !== "https:" || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) throw Error("CF_OAUTH_ORIGIN_INVALID");
  const issuer = publicOrigin.origin;
  const resource = issuer + "/mcp/oauth";
  const metadata = issuer + "/.well-known/oauth-protected-resource";
  const file = path.join(stateDir, "state.json");
  fs.mkdirSync(stateDir, {recursive:true,mode:0o700});
  fs.chmodSync(stateDir,0o700);
  const blank = () => ({schema:SCHEMA,clients:{},pending:{},codes:{},access:{},refresh:{}});
  function save(db) {
    const tmp = file + "." + process.pid + "." + hex(8);
    fs.writeFileSync(tmp, JSON.stringify(db)+"\n", {mode:0o600});
    fs.renameSync(tmp,file);
    fs.chmodSync(file,0o600);
  }
  if (!fs.existsSync(file)) save(blank());
  function load() {
    const db = JSON.parse(fs.readFileSync(file,"utf8"));
    if (db?.schema!==SCHEMA || !["clients","pending","codes","access","refresh"].every(k=>db[k] && typeof db[k]==="object" && !Array.isArray(db[k]))) throw Error("CF_OAUTH_STATE_INVALID");
    return db;
  }
  function prune(db) {
    for (const name of ["pending","codes","access","refresh"]) {
      for (const [id,v] of Object.entries(db[name])) if (!Number.isSafeInteger(v.expires) || v.expires<=Date.now()) delete db[name][id];
    }
  }
  function ownerAllowed(fp) {
    const state = ownerState();
    return state.mode==="enforce" && state.owners.some(x=>x.subject_fingerprint===fp);
  }
  function issue(db, owner, client) {
    const access = hex(32), refresh = hex(32);
    db.access[sha(access)]={owner,client,expires:Date.now()+ACCESS_MS};
    db.refresh[sha(refresh)]={owner,client,expires:Date.now()+REFRESH_MS};
    return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:3600,scope:"cf:execute"};
  }
  function verifyBearer(value) {
    if (typeof value!=="string" || !/^Bearer [0-9a-f]{64}$/.test(value)) return null;
    const item=load().access[sha(value.slice(7))];
    return item && item.expires>Date.now() && ownerAllowed(item.owner) ? {owner:item.owner,client:item.client}:null;
  }
  function approve(approval, owner) {
    if (!APPROVAL_RE.test(approval) || !ownerAllowed(owner)) throw Error("CF_OAUTH_OWNER_OR_CODE_INVALID");
    const db=load(); prune(db);
    const p=Object.values(db.pending).find(x=>x.approval===approval && x.status==="pending");
    if (!p) throw Error("CF_OAUTH_APPROVAL_NOT_PENDING");
    const code=hex(32);
    db.codes[sha(code)]={owner,client:p.client,redirect:p.redirect,challenge:p.challenge,expires:Date.now()+CODE_MS};
    p.status="approved";p.code=code;
    save(db);
    return {approved:true,mode:"enforce",expires_in_seconds:300};
  }
  function install(app) {
    app.get(["/.well-known/oauth-protected-resource","/.well-known/oauth-protected-resource/mcp/oauth"],(_req,res)=>{
      res.set("Cache-Control","public,max-age=120").json({resource,authorization_servers:[issuer],bearer_methods_supported:["header"],scopes_supported:["cf:execute"]});
    });
    app.get("/.well-known/oauth-authorization-server",(_req,res)=>{
      res.set("Cache-Control","public,max-age=120").json({issuer,
        authorization_endpoint:issuer+"/mcp/oauth/authorize",token_endpoint:issuer+"/mcp/oauth/token",
        registration_endpoint:issuer+"/mcp/oauth/register",revocation_endpoint:issuer+"/mcp/oauth/revoke",
        response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
        token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],
        scopes_supported:["cf:execute"]});
    });
    app.post("/mcp/oauth/register",(req,res)=>{
      const b=req.body||{}, uris=b.redirect_uris;
      if (!Array.isArray(uris)||!uris.length||uris.length>10||!uris.every(x=>typeof x==="string"&&validRedirect(x))) {err(res,"invalid_redirect_uri","HTTPS or loopback redirect URIs only");return;}
      if (b.token_endpoint_auth_method && b.token_endpoint_auth_method!=="none") {err(res,"invalid_client_metadata","PKCE public clients only");return;}
      const db=load(); if(Object.keys(db.clients).length>=100){err(res,"temporarily_unavailable","Client limit reached",429);return;}
      const client_id="cfclient_"+hex(18);
      db.clients[client_id]={redirects:[...new Set(uris)],name:String(b.client_name||"MCP client").slice(0,100)};
      save(db);
      res.status(201).set("Cache-Control","no-store").json({client_id,
        client_id_issued_at:Math.floor(Date.now()/1000),token_endpoint_auth_method:"none",
        grant_types:["authorization_code","refresh_token"],response_types:["code"],
        redirect_uris:db.clients[client_id].redirects,client_name:db.clients[client_id].name});
    });
    app.get("/mcp/oauth/authorize",(req,res)=>{
      const q=req.query||{},db=load(),client=db.clients[q.client_id];
      if (!client || q.response_type!=="code" || !client.redirects.includes(q.redirect_uri)
        || q.code_challenge_method!=="S256" || !CHALLENGE_RE.test(q.code_challenge||"")
        || q.resource!==resource || typeof q.state!=="string" || q.state.length<8 || q.state.length>2048
        || (q.scope&&q.scope!=="cf:execute")) {err(res,"invalid_request","Invalid OAuth authorization parameters");return;}
      prune(db);if(Object.keys(db.pending).length>=100){err(res,"temporarily_unavailable","Too many pending sessions",429);return;}
      const sid=hex(24),approval="CF-"+hex(6).toUpperCase();
      db.pending[sid]={approval,client:q.client_id,redirect:q.redirect_uri,challenge:q.code_challenge,state:q.state,status:"pending",expires:Date.now()+SESSION_MS};
      save(db);
      const page=[
        '<!doctype html><html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>CF-Server Authorization</title>',
        '<style>body{font:16px system-ui;max-width:540px;margin:3rem auto;padding:1rem;line-height:1.6}code{font-size:1.3rem}</style>',
        '<h1>Authorize CF-Server</h1><p>Requesting client: ',html(client.name),'</p>',
        '<p>In your already-authorized ChatGPT session, call <b>cf_oauth_approve</b> with this one-time code:</p><p><code>',approval,'</code></p>',
        '<p id="status">Waiting for approval by an existing owner...</p><script>',
        'const sid=',JSON.stringify(sid),';let busy=false;',
        'async function poll(){if(busy)return;busy=true;try{const r=await fetch("/mcp/oauth/poll/"+sid,{cache:"no-store"});const j=await r.json();',
        'if(j.status==="approved"){location.assign(j.redirect_url);return;}if(j.status==="expired"){document.getElementById("status").textContent="Expired. Restart the connection.";return;}}catch{}finally{busy=false;}}',
        'setInterval(poll,1500);poll();</script></html>'
      ].join("");
      res.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
        "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"}).type("html").send(page);
    });
    app.get("/mcp/oauth/poll/:sid",(req,res)=>{
      const p=load().pending[req.params.sid];
      if(!p||p.expires<=Date.now()){res.set("Cache-Control","no-store").json({status:"expired"});return;}
      if(p.status!=="approved"){res.set("Cache-Control","no-store").json({status:"pending"});return;}
      const redirect=new URL(p.redirect);redirect.searchParams.set("code",p.code);redirect.searchParams.set("state",p.state);
      res.set("Cache-Control","no-store").json({status:"approved",redirect_url:redirect.toString()});
    });
    app.post("/mcp/oauth/token",(req,res)=>{
      const b=req.body||{},db=load();prune(db);
      if(!db.clients[b.client_id]){err(res,"invalid_client","Unknown client",401);return;}
      if(b.resource!==resource){err(res,"invalid_target","Wrong resource");return;}
      if(b.grant_type==="authorization_code"){
        if(!VERIFIER_RE.test(b.code_verifier||"")){err(res,"invalid_grant","Invalid PKCE verifier");return;}
        const c=typeof b.code==="string"?b.code:"",entry=db.codes[sha(c)];
        if(!entry||entry.client!==b.client_id||entry.redirect!==b.redirect_uri||challengeFor(b.code_verifier)!==entry.challenge||!ownerAllowed(entry.owner)){
          err(res,"invalid_grant","Code invalid, expired, or already used");return;
        }
        delete db.codes[sha(c)];
        for(const [sid,p] of Object.entries(db.pending)) if(p.code===c) delete db.pending[sid];
        const tokens=issue(db,entry.owner,entry.client);save(db);
        res.set("Cache-Control","no-store").json(tokens);return;
      }
      if(b.grant_type==="refresh_token"){
        const t=typeof b.refresh_token==="string"?b.refresh_token:"",entry=db.refresh[sha(t)];
        if(!entry||entry.client!==b.client_id||!ownerAllowed(entry.owner)){err(res,"invalid_grant","Invalid refresh token");return;}
        delete db.refresh[sha(t)];const tokens=issue(db,entry.owner,entry.client);save(db);
        res.set("Cache-Control","no-store").json(tokens);return;
      }
      err(res,"unsupported_grant_type","Authorization code and refresh only");
    });
    app.post("/mcp/oauth/revoke",(req,res)=>{
      const b=req.body||{},db=load(),digest=sha(typeof b.token==="string"?b.token:"");
      if(db.refresh[digest]?.client===b.client_id)delete db.refresh[digest];
      if(db.access[digest]?.client===b.client_id)delete db.access[digest];
      save(db);res.set("Cache-Control","no-store").status(200).end();
    });
  }
  function sendUnauthorized(res) {
    res.set("WWW-Authenticate",'Bearer resource_metadata="'+metadata+'", scope="cf:execute"');
    err(res,"invalid_token","Owner-approved OAuth bearer token required",401);
  }
  return {install,approve,verifyBearer,sendUnauthorized,issuer,resource,stateFile:file};
}
