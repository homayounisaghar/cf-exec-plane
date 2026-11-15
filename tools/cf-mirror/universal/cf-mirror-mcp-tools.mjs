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
  'List all accessible CDP browser ports, tabs and X11 displays/windows on the owner server.',
  {},readonly,async(input,extra)=>run([BIN,'list'],extra,{seconds:20}));
 register('cf_mirror_status','Universal mirror sessions',
  'List active local/public mirror sessions, their URLs, sources and expiration times; does not reveal passwords.',
  {},readonly,async(input,extra)=>run([BIN,'status'],extra,{seconds:15}));
 register('cf_mirror_open','Open universal local or web mirror',
  'Start a mirror of any accessible browser/CDP profile or X11 app. Default local gives a simple numeric 127.0.0.1 address for the server graphical browser. Explicit mode=web gives HTTPS Quick Tunnel and a mandatory password (auto-generated unless specified), expires after ttl. Omit tab to show ALL browser tabs with navigation/open/close; use tab only to mirror a specific page. Domains/Google OAuth redirects are not restricted. Access to a public mirror grants full mouse/keyboard control.',
  {name:schemaName.optional(),app:z.string().min(1).max(140).optional(),
   cdp:z.number().int().min(1).max(65535).optional(),
   x11:z.string().regex(/^:\d+$/).optional(),
   tab:z.string().min(1).max(300).optional(),
   mode:z.enum(['local','web']).optional(),
   ttl:z.union([z.string().regex(/^\d+(s|m|h)?$/),z.number().int().min(30).max(86400)]).optional(),
   password:z.string().min(8).max(300).optional(),
   interval:z.union([z.literal('auto'),z.number().min(0.05).max(5)]).optional(),
   full:z.boolean().optional(),no_fit:z.boolean().optional()},
  changing,async(input,extra)=>{
   const cmd=[BIN,'start'];
   if(input.name)cmd.push(input.name);
   if(input.app)cmd.push('--app',input.app);
   if(input.cdp)cmd.push('--cdp',String(input.cdp));
   if(input.x11)cmd.push('--x11',input.x11);
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
  'Immediately revoke one universal mirror session or all, including public URL, image streams and input control.',
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
