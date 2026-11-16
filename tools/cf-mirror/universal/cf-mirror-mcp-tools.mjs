// Optional CF native MCP adapter for CF Universal Mirror.
// Register this from the CF release's owner-authorized MCP preload, e.g.
// registerCfMirrorUniversalTools(server, z, { callAgent, callerIdentity });
// This module is staged in source; registration requires a CF release deployment.
// All commands are executed by the existing authorized CF host agent (server_exec).
const BIN='/home/cfserver/.local/bin/cf-mirror-any';
const quote=x=>"'"+String(x).replace(/'/g,"'\"'\"'")+"'";
const output=(o,isError=false)=>({structuredContent:o,content:[{type:'text',text:JSON.stringify(o)}],...(isError?{isError:true}:{})});
const err=(msg)=>output({ok:false,error:String(msg).slice(0,500)},true);
export function registerCfMirrorUniversalTools(server,z,{callAgent,callerIdentity}={}){
 if(typeof callAgent!=='function')throw Error('callAgent must be provided by cf-ops-tools.mjs');
 const owner=extra=>typeof callerIdentity==='function'?callerIdentity(extra).slice(0,190):'cf-mirror-mcp';
 const schemaName=z.string().regex(/^[A-Za-z0-9_-]{1,45}$/);
 const readonly={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
 const changing={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true};
 const destructive={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
 async function run(parts,extra,{env,seconds=55}={}){
  const command=parts.map(quote).join(' ');
  const options={command,timeout_s:seconds};
  if(env)options.env=env;
  const r=await callAgent('server_exec',options,(seconds+15)*1000,owner(extra));
  if(!r?.ok)return {ok:false,error:r?.error?.message||r?.error?.code||'CF agent unavailable'};
  if(r.result.exit_code!==0)return {ok:false,error:String(r.result.stderr||r.result.stdout||'mirror command failed').slice(0,1000)};
  const lines=String(r.result.stdout||'').split('\n').filter(Boolean);
  try{return JSON.parse(lines.at(-1));}
  catch{return {ok:false,error:'Unexpected mirror command output'};}
 }
 function register(name,title,description,schema,annotations,handler){
  server.registerTool(name,{title,description,inputSchema:schema,annotations},async(input,extra)=>{
   try{const r=await handler(input||{},extra);return output(r,!r?.ok);}
   catch(e){return err(e.message||e);}
  });
 }
 register('cf_mirror_sources','List mirrorable browsers and apps',
  'Discover Chrome/CDP tabs and X11 displays with visible window_details containing numeric ID, title and WM_CLASS. For an exact native Linux app window (including a terminal or emulator), call cf_mirror_open({x11:":10",window_id:WINDOW_ID}) or use app/window selector; full:true is for the entire X11 desktop. A local URL works only ON THE SERVER, not on the phone.',
  {},readonly,async(input,extra)=>run([BIN,'list'],extra,{seconds:20}));
 register('cf_mirror_status','Universal mirror sessions',
  'Check created local or public mirroring sessions, their URLs, targets, active/expired status, and public expiry. Present web URLs as tappable links but local 127.0.0.1 URLs as copyable plain text, NEVER as hyperlinks. Does NOT reveal session passwords, which are shown only at creation. A new web session needs a new one-time password; local mirrors require none.',
  {},readonly,async(input,extra)=>run([BIN,'status'],extra,{seconds:15}));
 register('cf_mirror_open','Open universal local or web mirror',
  'CREATE MIRROR ON REQUEST / MIRRORING / mirror / share a browser or app: when owner asks in Persian/English for an internet/public mirror of any Chrome/CDP tab, browser or X11 app for N minutes/hours, CALL cf_mirror_open with mode=web, target app/x11/cdp or an exact X11 window/window_id, and ttl (e.g. 5h, 30m). Password is generated automatically; do NOT ask for one. Present response.url as a TAPPABLE HTTPS link, response.password in a COPYABLE code block or copy button, expiry in user timezone, and always warn: VPN MAY BE REQUIRED to view/control/stream; VPN-free playback is not guaranteed. A Quick Tunnel can fail early. When owner requests LOCAL mirroring, CALL cf_mirror_open with mode=local (or omit mode), target app/x11/cdp, and DO NOT request or send password or ttl; present the returned numeric http://127.0.0.1:PORT/ URL as COPYABLE PLAIN CODE or a COPY LINK button (GenUI.copy where supported); NEVER render a clickable/tappable hyperlink for local. The user will paste that URL into a browser ON THE SERVER graphical/XRDP desktop, not open it on their phone. Local is loopback-only, passwordless and has no expiry by default. Native X11 window mirrors include the whole outer frame/title bar using _NET_FRAME_EXTENTS when the window manager provides it, and pin the exact window ID to prevent switching to another app. Use window for an X11 title/class selector, or window_id together with x11 to select a specific visible X11 window; x11 alone retains legacy largest-window behavior and full:true captures the whole display. If ambiguous, use cf_mirror_sources; avoid asking for a password or duration for local. Keep existing source/tab selectors. Public URL+password grant full mouse/keyboard control; share only with owner.',
  {name:schemaName.optional(),app:z.string().min(1).max(140).optional(),
   cdp:z.number().int().min(1).max(65535).optional(),
   x11:z.string().regex(/^:\d+$/).optional(),
   window:z.string().min(1).max(200).optional(),
   window_id:z.number().int().min(1).max(4294967295).optional(),
   tab:z.string().min(1).max(300).optional(),
   mode:z.enum(['local','web']).optional(),
   ttl:z.union([z.string().regex(/^\d+(s|m|h)?$/),z.number().int().min(30).max(86400)]).optional(),
   password:z.string().min(8).max(300).optional(),
   interval:z.union([z.literal('auto'),z.number().min(0.05).max(5)]).optional(),
   full:z.boolean().optional(),no_fit:z.boolean().optional()},
  changing,async(input,extra)=>{
   if((input.mode||'local')==='local'&&input.ttl!==undefined)throw Error('Local mirrors do not accept ttl; omit ttl (local sessions have no scheduled expiry)');
   const cmd=[BIN,'start'];
   if(input.name)cmd.push(input.name);
   if(input.app)cmd.push('--app',input.app);
   if(input.cdp)cmd.push('--cdp',String(input.cdp));
   if(input.x11)cmd.push('--x11',input.x11);
   if(input.window)cmd.push('--window',input.window);
   if(input.window_id)cmd.push('--window-id',String(input.window_id));
   if(input.tab)cmd.push('--tab',input.tab);
   if(input.mode)cmd.push('--mode',input.mode);
   if(input.ttl!==undefined)cmd.push('--ttl',String(input.ttl));
   if(input.interval!==undefined)cmd.push('--interval',String(input.interval));
   if(input.full)cmd.push('--full');
   if(input.no_fit)cmd.push('--no-fit');
   let env;
   if(input.password!==undefined){
    if(input.mode!=='web')throw Error('password is available only for explicit web mode');
    cmd.push('--password','__CF_MIRROR_WEB_PASSWORD__');
    env={CF_MIRROR_WEB_PASSWORD:input.password};
   }
   // Substitute a quoted environment expansion, not the actual password, in the shell.
   let command=cmd.map(quote).join(' ');
   command=command.replace(quote('__CF_MIRROR_WEB_PASSWORD__'),'"$CF_MIRROR_WEB_PASSWORD"');
   const options={command,timeout_s:60};
   if(env)options.env=env;
   const r=await callAgent('server_exec',options,75000,owner(extra));
   if(!r?.ok)return {ok:false,error:r?.error?.message||r?.error?.code||'CF agent unavailable'};
   if(r.result.exit_code!==0)return {ok:false,error:String(r.result.stderr||r.result.stdout||'mirror start failed').slice(0,1000)};
   try{return JSON.parse(String(r.result.stdout||'').trim().split('\n').at(-1));}
   catch{return {ok:false,error:'Unexpected mirror start output'};}
  });
 register('cf_mirror_close','Stop and revoke mirror session',
  'Stop/revoke a named local or internet mirror immediately (or all when explicitly requested). Public links/passwords and streams stop working. Do not stop sessions just because no VPN is available; only stop on owner request or session expiry.',
  {name:z.union([schemaName,z.literal('all')])},destructive,
  async(input,extra)=>run([BIN,'stop',input.name],extra,{seconds:25}));
 register('cf_mirror_screenshot','Screenshot an active universal mirror',
  'Capture the CURRENT visible image of the specified mirror without navigating. Returns JPEG image when <=1MB, otherwise returns the saved server-side path.',
  {name:schemaName},changing,
  async(input,extra)=>{
   const r=await run([BIN,'screenshot',input.name],extra,{seconds:25});
   if(!r.ok||!r.path)return r;
   const read=await callAgent('server_file_read',{path:r.path,length:1048576,encoding:'base64'},30000,owner(extra));
   if(!read?.ok||!read.result?.content||read.result.next_offset<read.result.size_bytes)return r;
   // Special result handled by wrapper below only if image contents were read successfully.
   return {...r,_image:read.result.content};
  });
 // Upgrade the screenshot handler's return shape to an MCP image when possible.
 const sr=server._registeredTools?.cf_mirror_screenshot;
 if(sr?.handler){
  const old=sr.handler;
  sr.handler=async(input,extra)=>{
   const r=await old(input,extra),j=r?.structuredContent;
   if(j?.ok&&j._image){
    const img=j._image;
    const safe={...j};delete safe._image;
    return {structuredContent:safe,content:[{type:'image',data:img,mimeType:'image/jpeg'},{type:'text',text:JSON.stringify(safe)}]};
   }
   return r;
  };
 }
}
