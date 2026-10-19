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
// r253: owner approves a pairing on this page with a one-time code sent to the owner's Telegram
// Saved Messages (through the cf-ops root-approval wrapper; the approved command is a no-op).
const TG_SENDS_PER_SESSION = 2, TG_TRIES_PER_SESSION = 5, TG_SENDS_PER_HOUR = 4;
const SID_RE = /^[0-9a-f]{48}$/;
const tgSendTimes = [];
const tgAgent = () => { const f = globalThis.__cfOpsCallAgent; if (typeof f !== "function") throw Object.assign(Error("TELEGRAM_APPROVAL_UNAVAILABLE"), {code:"TELEGRAM_APPROVAL_UNAVAILABLE"}); return f; };
const tgSafe = value => String(value || "").replace(/[^A-Za-z0-9 ._:-]/g, "").trim();
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
  function ownerAllowed(fp, organization = null) {
    const state = ownerState();
    return state.mode==="enforce" && state.owners.some(x=>x.subject_fingerprint===fp)
      && Array.isArray(state.organization_fingerprints)
      && (!state.organization_fingerprints.length || (typeof organization==="string" && state.organization_fingerprints.includes(organization)));
  }
  function issue(db, owner, organization, client) {
    const access = hex(32), refresh = hex(32);
    db.access[sha(access)]={owner,organization,client,expires:Date.now()+ACCESS_MS};
    db.refresh[sha(refresh)]={owner,organization,client,expires:Date.now()+REFRESH_MS};
    return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:3600,scope:"cf:execute"};
  }
  function verifyBearer(value) {
    if (typeof value!=="string" || !/^Bearer [0-9a-f]{64}$/.test(value)) return null;
    const item=load().access[sha(value.slice(7))];
    return item && item.expires>Date.now() && ownerAllowed(item.owner,item.organization) ? {owner:item.owner,organization:item.organization,client:item.client}:null;
  }
  function approve(approval, owner, organization = null) {
    if (!APPROVAL_RE.test(approval) || !ownerAllowed(owner,organization)) throw Error("CF_OAUTH_OWNER_OR_CODE_INVALID");
    const db=load(); prune(db);
    const p=Object.values(db.pending).find(x=>x.approval===approval && x.status==="pending");
    if (!p) throw Error("CF_OAUTH_APPROVAL_NOT_PENDING");
    const code=hex(32);
    db.codes[sha(code)]={owner,organization,client:p.client,redirect:p.redirect,challenge:p.challenge,expires:Date.now()+CODE_MS};
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
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:540px;margin:3rem auto;padding:1rem;line-height:1.6}code{font-size:1.3rem}button{font-size:1.1rem;padding:.6rem 1rem}#tgmsg{font-weight:600}</style>',
        '<h1>Authorize CF-Server</h1><p>Requesting client: ',html(client.name),'</p>',
        '<h2>Approve with Telegram</h2><p><button id="tgsend" type="button">Send code to my Telegram</button></p>',
        '<p><input id="tgcode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="6-digit code" style="font-size:1.3rem;width:9em"> <button id="tgok" type="button">Approve</button></p>',
        '<p id="tgmsg"></p>',
        '<h2>Or approve with ChatGPT</h2><p>In your already-authorized ChatGPT session, call <b>cf_oauth_approve</b> with this one-time code:</p><p><code>',approval,'</code></p>',
        '<p id="status">Waiting for approval by an existing owner...</p><script>',
        'const sid=',JSON.stringify(sid),';let busy=false;',
        'async function poll(){if(busy)return;busy=true;try{const r=await fetch("/mcp/oauth/poll/"+sid,{cache:"no-store"});const j=await r.json();',
        'if(j.status==="approved"){location.assign(j.redirect_url);return;}if(j.status==="expired"){document.getElementById("status").textContent="Expired. Restart the connection.";return;}}catch{}finally{busy=false;}}',
        'const msg=t=>{document.getElementById("tgmsg").textContent=t;};',
        'async function tg(kind,body){try{const r=await fetch("/mcp/oauth/tg-"+kind+"/"+sid,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{}),cache:"no-store"});const j=await r.json();return j;}catch{return {error:"network",error_description:"Network error, try again."};}}',
        'document.getElementById("tgsend").addEventListener("click",async()=>{msg("Sending...");const j=await tg("send");msg(j.sent?"Code sent to your Telegram Saved Messages. Enter it below.":(j.error_description||"Could not send."));});',
        'document.getElementById("tgok").addEventListener("click",async()=>{msg("Checking...");const j=await tg("verify",{code:document.getElementById("tgcode").value});msg(j.approved?"Approved. Returning to your app...":(j.error_description||"Not approved."));if(j.approved)poll();});',
        'setInterval(poll,1500);poll();</script></html>'
      ].join("");
      res.set({"Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",
        "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"}).type("html").send(page);
    });
    function primaryOwner() {
      const st = ownerState();
      const owner = st?.owners?.[0]?.subject_fingerprint;
      const organization = Array.isArray(st?.organization_fingerprints) && st.organization_fingerprints.length ? st.organization_fingerprints[0] : null;
      if (!owner || !ownerAllowed(owner, organization)) throw Object.assign(Error("CF_OAUTH_NO_OWNER"), {code:"CF_OAUTH_NO_OWNER"});
      return {owner, organization};
    }
    function tgPending(req, res) {
      const sid = req.params?.sid;
      if (!SID_RE.test(sid || "")) { err(res, "invalid_request", "Unknown session", 404); return null; }
      const db = load(); prune(db);
      const p = db.pending[sid];
      if (!p || p.status !== "pending") { err(res, "invalid_request", "Session expired or already approved. Restart the connection.", 404); return null; }
      return {db, p, sid};
    }
    app.post("/mcp/oauth/tg-send/:sid", async (req, res) => {
      const got = tgPending(req, res); if (!got) return;
      const {db, p, sid} = got;
      if ((p.tg_sends || 0) >= TG_SENDS_PER_SESSION) { err(res, "slow_down", "A code was already sent. Check Telegram Saved Messages.", 429); return; }
      const now = Date.now();
      while (tgSendTimes.length && tgSendTimes[0] <= now - 3600000) tgSendTimes.shift();
      if (tgSendTimes.length >= TG_SENDS_PER_HOUR) { err(res, "slow_down", "Too many codes this hour. Try again later.", 429); return; }
      let call;
      try { call = tgAgent(); primaryOwner(); } catch (e) { err(res, "temporarily_unavailable", "Telegram approval is not available: " + (e.code || "ERROR"), 503); return; }
      tgSendTimes.push(now);
      p.tg_sends = (p.tg_sends || 0) + 1; save(db);
      const name = tgSafe(db.clients[p.client]?.name).slice(0, 40) || "MCP client";
      let host = "?"; try { host = tgSafe(new URL(p.redirect).host).slice(0, 80) || "?"; } catch {}
      const reason = "Approve CF-server connection for client " + name + " (returns to " + host + "). Enter this code only on the CF-Server page you opened yourself; never send it to anyone. Command is a no-op.";
      let r;
      try { r = await call("server_admin_request", {command: "true", reason, timeout_s: 10}, 30000, "oauth-pairing-page"); }
      catch (e) { r = {ok:false, error:{code: e?.code || "AGENT_UNAVAILABLE"}}; }
      if (!r?.ok || !/^[0-9a-f]{16}$/.test(String(r?.result?.request_id || ""))) { err(res, "temporarily_unavailable", "Could not send the Telegram code (" + tgSafe(r?.error?.code || "ERROR").slice(0, 60) + ").", 503); return; }
      const db2 = load(), p2 = db2.pending[sid];
      if (!p2 || p2.status !== "pending") { err(res, "invalid_request", "Session expired. Restart the connection.", 404); return; }
      p2.tg_rid = r.result.request_id; p2.tg_tries = 0; save(db2);
      res.set("Cache-Control", "no-store").json({sent: true, expires_in_s: Number(r.result.expires_in_s) || 600});
    });
    app.post("/mcp/oauth/tg-verify/:sid", async (req, res) => {
      const code = String(req.body?.code ?? "").replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) { err(res, "invalid_request", "Enter the 6-digit code from Telegram."); return; }
      const got = tgPending(req, res); if (!got) return;
      const {db, p} = got;
      if (!p.tg_rid) { err(res, "invalid_request", "Send a code to Telegram first.", 409); return; }
      if ((p.tg_tries || 0) >= TG_TRIES_PER_SESSION) { err(res, "access_denied", "Too many wrong codes. Restart the connection.", 429); return; }
      p.tg_tries = (p.tg_tries || 0) + 1; save(db);
      const left = TG_TRIES_PER_SESSION - p.tg_tries;
      let r;
      try { r = await tgAgent()("server_admin_approve", {request_id: p.tg_rid, code}, 60000, "oauth-pairing-page"); }
      catch (e) { r = {ok:false, error:{code: e?.code || "AGENT_UNAVAILABLE"}}; }
      if (!r?.ok || r?.result?.exit_code !== 0) {
        const c = tgSafe(r?.error?.code || "NOT_APPROVED").slice(0, 60);
        err(res, "access_denied", (c === "CODE_INVALID" ? "Wrong code." : "Not approved (" + c + ").") + " Attempts left: " + left, 403); return;
      }
      try { const o = primaryOwner(); approve(p.approval, o.owner, o.organization); }
      catch (e) { err(res, "server_error", "Approval failed (" + tgSafe(e?.code || e?.message).slice(0, 60) + ").", 500); return; }
      res.set("Cache-Control", "no-store").json({approved: true});
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
        if(!entry||entry.client!==b.client_id||entry.redirect!==b.redirect_uri||challengeFor(b.code_verifier)!==entry.challenge||!ownerAllowed(entry.owner,entry.organization)){
          err(res,"invalid_grant","Code invalid, expired, or already used");return;
        }
        delete db.codes[sha(c)];
        for(const [sid,p] of Object.entries(db.pending)) if(p.code===c) delete db.pending[sid];
        const tokens=issue(db,entry.owner,entry.organization,entry.client);save(db);
        res.set("Cache-Control","no-store").json(tokens);return;
      }
      if(b.grant_type==="refresh_token"){
        const t=typeof b.refresh_token==="string"?b.refresh_token:"",entry=db.refresh[sha(t)];
        if(!entry||entry.client!==b.client_id||!ownerAllowed(entry.owner,entry.organization)){err(res,"invalid_grant","Invalid refresh token");return;}
        delete db.refresh[sha(t)];const tokens=issue(db,entry.owner,entry.organization,entry.client);save(db);
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
