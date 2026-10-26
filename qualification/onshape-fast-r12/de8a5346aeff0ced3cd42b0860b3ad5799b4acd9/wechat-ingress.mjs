const DEFAULT_SEMANTIC_URL = "http://127.0.0.1:9337";

const CAPABILITIES = [
  ["wechat_capability_list","read","Describe the qualified and implemented WeChat semantic surface."],
  ["wechat_capability_gaps","read","Report explicit Telegram-parity gaps without inventing provider semantics."],
  ["wechat_conversation_list","read","Scan recent WeChat conversation rows without opening chats."],
  ["wechat_unread_list","read","List explicit unread conversation badges without opening chats."],
  ["wechat_conversation_search","read","Use bounded WeChat search UI and restore the chat view."],
  ["wechat_contact_search","read","Search WeChat Contacts through bounded provider UI search."],
  ["wechat_message_search","read","Return WeChat Chat History search results when the provider UI exposes them."],
  ["wechat_selected_conversation","read","Inspect the currently selected conversation."],
  ["wechat_chat_view","conditional-read","Open one exact conversation only when read-state risk is explicitly accepted, then return a screenshot."],
  ["wechat_screenshot","read","Capture the current private WeChat viewport."],
  ["wechat_send","write-unverified","Send text through the bounded composer; never claim provider confirmation."],
  ["wechat_mark_read","write-unverified","Use the exact conversation context action when available."],
  ["wechat_mark_unread","write-unverified","Use the exact conversation context action when available."],
  ["wechat_mute","write-unverified","Mute or unmute an exact visible conversation through a bounded context action."],
  ["wechat_pin","write-unverified","Pin or unpin an exact visible conversation through a bounded context action."],
];

const GAPS = [
  { operation:"wechat_message_list", state:"NOT_RELIABLY_IMPLEMENTABLE_CURRENT_RUNTIME", reason:"The official Linux accessibility tree exposes the Messages viewport but not stable message children. Opening chats can also change read state. Screenshot-based chat_view is the bounded fallback." },
  { operation:"wechat_message_replies", state:"PROVIDER_SEMANTICS_UNPROVEN", reason:"No stable Telegram-style thread/reply enumeration contract is exposed by this WeChat client." },
  { operation:"wechat_reply", state:"POSSIBLE_BUT_UNQUALIFIED", reason:"Message identity is not stable enough to target an exact quoted message safely." },
  { operation:"wechat_reaction_get", state:"PROVIDER_SEMANTICS_UNPROVEN", reason:"Ordinary Telegram-style reaction semantics have not been proven for this WeChat client." },
  { operation:"wechat_react", state:"PROVIDER_SEMANTICS_UNPROVEN", reason:"No reliable ordinary reaction mutation contract has been proven." },
  { operation:"wechat_forward", state:"POSSIBLE_BUT_UNQUALIFIED", reason:"Forward UI semantics cannot yet be bound to a stable source-message identity." },
  { operation:"wechat_edit", state:"PROVIDER_SEMANTICS_UNPROVEN", reason:"No reliable WeChat message-edit contract has been proven." },
  { operation:"wechat_delete", state:"FAIL_CLOSED", reason:"Conversation delete/recall confirmation UI is not qualified and is therefore not exposed." },
  { operation:"wechat_attachment_get", state:"NOT_RELIABLY_IMPLEMENTABLE_CURRENT_RUNTIME", reason:"Business message/resource stores are encrypted WCDB/SQLCipher and stable message-to-attachment identity is unavailable." },
  { operation:"wechat_file_send", state:"POSSIBLE_BUT_UNQUALIFIED", reason:"Shared material staging and a bounded chooser path are implemented internally, but live qualification could not prove a distinct official file chooser. The provider-send tool remains unexposed and fail-closed." },
  { operation:"wechat_voice_send_file", state:"POSSIBLE_BUT_UNQUALIFIED", reason:"The Linux client exposes a Send Voice control, but safe deterministic file-to-native-voice injection is not qualified." },
  { operation:"wechat_provider_fresh_write_verification", state:"UNAVAILABLE", reason:"Current writes are UI-driven. Same-runtime accessibility/UI cannot independently confirm their provider result, so successful dispatch remains ACKNOWLEDGED_UNVERIFIED/IN_DOUBT." },
  { operation:"wechat_restart_persistence", state:"UNQUALIFIED_BY_OWNER_CHOICE", reason:"The owner explicitly deferred WeChat restart qualification; do not restart the authenticated process for testing." },
];

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function result(value) {
  return { structuredContent:value, content:[{type:"text",text:JSON.stringify(value,null,1)}] };
}
function failure(error, fallback) {
  return result({
    state:"FAILED", provider:"wechat", realization:"linux-atspi-semantic-helper",
    error:{ code:error?.code || fallback, message:String(error?.message || fallback).slice(0,300) },
  });
}
async function getJson(url, code, timeout=7000) {
  let response;
  try { response=await fetch(url,{signal:AbortSignal.timeout(timeout),cache:"no-store"}); }
  catch (cause) { const e=codedError(code); e.cause=cause; throw e; }
  let value;
  try { value=await response.json(); } catch { throw codedError("WECHAT_RUNTIME_INVALID_JSON"); }
  if (!response.ok || value?.ok===false) throw codedError(String(value?.error || code));
  return value;
}
async function postJson(base, path, body, code, timeout=15000) {
  let response;
  try {
    response=await fetch(base+path,{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(body),signal:AbortSignal.timeout(timeout),cache:"no-store",
    });
  } catch (cause) { const e=codedError(code); e.cause=cause; throw e; }
  let value;
  try { value=await response.json(); } catch { throw codedError("WECHAT_RUNTIME_INVALID_JSON"); }
  if (!response.ok || value?.ok===false) throw codedError(String(value?.error || code));
  return value;
}
async function getBinary(url, code) {
  let response;
  try { response=await fetch(url,{signal:AbortSignal.timeout(10000),cache:"no-store"}); }
  catch (cause) { const e=codedError(code); e.cause=cause; throw e; }
  if (!response.ok) throw codedError(code);
  return Buffer.from(await response.arrayBuffer());
}
function normalizeConversation(item) {
  const name=String(item?.name || "").trim();
  if (!name) return null;
  const unread=Math.max(0,Number(item?.unread_count || 0));
  return {
    conversation_ref:"wechat-name:"+encodeURIComponent(name),
    name, identity_strength:"display_name_snapshot", duplicate_name_safe:false,
    selected:Boolean(item?.selected), unread_count:unread, has_unread:unread>0,
    read_state:unread>0 ? "explicit_unread" : "no_explicit_unread_badge",
    muted:Boolean(item?.muted), pinned:null,
    timestamp:item?.timestamp ? String(item.timestamp) : null,
    preview:item?.preview ? String(item.preview).slice(0,1200) : null,
    source:"bounded_atspi_semantic_helper",
  };
}
async function currentConversations(semanticUrl) {
  const status=await getJson(semanticUrl+"/status","WECHAT_SEMANTIC_RUNTIME_UNAVAILABLE",5000);
  if (status?.authenticated!==true) throw codedError("WECHAT_LOGIN_REQUIRED");
  const payload=await getJson(semanticUrl+"/conversations","WECHAT_CONVERSATION_AUTHORITY_UNAVAILABLE",5000);
  const conversations=(payload.conversations||[]).map(normalizeConversation).filter(Boolean);
  const counts=new Map();
  for(const item of conversations) counts.set(item.name,(counts.get(item.name)||0)+1);
  for(const item of conversations) item.duplicate_name_detected=(counts.get(item.name)||0)>1;
  return {conversations,complete:Boolean(payload.complete),read_state_changed:Boolean(payload.read_state_changed)};
}
async function scanConversations(semanticUrl,limit=50,max_pages=20) {
  const payload=await postJson(semanticUrl,"/conversation-scan",{limit,max_pages},"WECHAT_CONVERSATION_SCAN_FAILED",25000);
  const conversations=(payload.conversations||[]).map(normalizeConversation).filter(Boolean);
  return {conversations,complete:Boolean(payload.complete),pages_scanned:Number(payload.pages_scanned||0),read_state_changed:Boolean(payload.read_state_changed)};
}
const SEARCH_HEADERS=new Set(["Contacts","Group Chats","Chat History","More","Search WeChat ID","Internet search results"]);
function parseSearchItems(payload) {
  const rows=(payload?.items||[])
    .filter((x)=>x?.role==="list item" && Array.isArray(x?.states) && x.states.includes("transient") && x?.name)
    .filter((x)=>Number(x?.bounds?.x||0)>=320 && Number(x?.bounds?.width||0)>=280)
    .sort((a,b)=>Number(a?.bounds?.y||0)-Number(b?.bounds?.y||0));
  let category=null;
  const out=[];
  for(const row of rows) {
    const name=String(row.name||"").trim();
    if (SEARCH_HEADERS.has(name)) { category=name; continue; }
    if (!name || /^View All\(/.test(name)) continue;
    out.push({category:category||"Unknown",name,bounds:row.bounds||null});
  }
  return out;
}
async function providerSearch(semanticUrl,query,section="Search") {
  const payload=await postJson(semanticUrl,"/navigation-probe",{section,query},"WECHAT_PROVIDER_SEARCH_FAILED",15000);
  return {query,results:parseSearchItems(payload),provider_visible_state_changed:Boolean(payload.provider_visible_state_changed)};
}
function materialHostPath(ready) {
  const handle=String(ready?.material_file_handle||"");
  const m=/^pcgfile:([0-9a-f]{64})$/.exec(handle);
  if(!m) throw codedError("WECHAT_MATERIAL_HANDLE_INVALID");
  const filename=String(ready?.filename||"").trim();
  if(!filename || filename.length>128 || /[\\/\u0000]/u.test(filename)) throw codedError("WECHAT_MATERIAL_FILENAME_INVALID");
  return "/var/lib/capability-fabric/pcg/run/material-files/"+m[1]+"-"+filename;
}

export const __wechatTest=Object.freeze({normalizeConversation,parseSearchItems,materialHostPath});

export function registerWeChatConversationTool(server,z,{semanticUrl=DEFAULT_SEMANTIC_URL,materialUpload=null}={}) {
  const requireMaterial=()=>{
    if(!materialUpload || typeof materialUpload.create!=="function" || typeof materialUpload.status!=="function" || typeof materialUpload.delete!=="function" || typeof materialUpload.append!=="function" || typeof materialUpload.ready!=="function" || typeof materialUpload.markSendStarted!=="function") {
      throw codedError("WECHAT_MATERIAL_UPLOAD_UNAVAILABLE");
    }
    return materialUpload;
  };

  server.registerTool("wechat_capability_list",{
    title:"List WeChat capabilities",description:"Return the implemented bounded WeChat surface and its effect class.",inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async()=>result({state:"ACHIEVED",provider:"wechat",capabilities:CAPABILITIES.map(([name,effect,description])=>({name,effect,description}))}));

  server.registerTool("wechat_capability_gaps",{
    title:"List WeChat capability gaps",description:"Report truthful Telegram-parity gaps instead of inventing unsupported WeChat semantics.",inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async()=>result({state:"ACHIEVED",provider:"wechat",gaps:GAPS}));

  server.registerTool("wechat_conversation_list",{
    title:"List WeChat conversations",description:"Boundedly scroll the WeChat chat list without opening conversations. The helper restores the list upward after scanning; complete remains false unless a future provider authority proves totality.",
    inputSchema:{limit:z.number().int().min(1).max(500).optional(),max_pages:z.number().int().min(1).max(50).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },async({limit=50,max_pages=20})=>{try{const x=await scanConversations(semanticUrl,limit,max_pages);return result({state:"ACHIEVED",provider:"wechat",scope:"bounded_recent_chat_scan",...x});}catch(error){return failure(error,"WECHAT_CONVERSATION_LIST_FAILED");}});

  server.registerTool("wechat_unread_list",{
    title:"List unread WeChat conversations",description:"Scan recent chat rows and return only explicit unread badges without opening chats.",
    inputSchema:{limit:z.number().int().min(1).max(500).optional(),max_pages:z.number().int().min(1).max(50).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },async({limit=100,max_pages=20})=>{try{const x=await scanConversations(semanticUrl,limit,max_pages);return result({state:"ACHIEVED",provider:"wechat",complete:x.complete,read_state_changed:x.read_state_changed,conversations:x.conversations.filter(v=>v.unread_count>0)});}catch(error){return failure(error,"WECHAT_UNREAD_LIST_FAILED");}});

  server.registerTool("wechat_conversation_search",{
    title:"Search WeChat conversations",description:"Use the provider search UI transiently, restore the WeChat chat view, and return exact visible search categories/results.",
    inputSchema:{query:z.string().trim().min(1).max(128),limit:z.number().int().min(1).max(100).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },async({query,limit=50})=>{try{const x=await providerSearch(semanticUrl,query,"Search");const matches=x.results.filter(v=>v.category==="Contacts"||v.category==="Group Chats").slice(0,limit);return result({state:"ACHIEVED",provider:"wechat",query,provider_visible_state_changed:x.provider_visible_state_changed,matches});}catch(error){return failure(error,"WECHAT_CONVERSATION_SEARCH_FAILED");}});

  server.registerTool("wechat_contact_search",{
    title:"Search WeChat contacts",description:"Search the WeChat Contacts UI transiently and restore the normal chat view.",
    inputSchema:{query:z.string().trim().min(1).max(128),limit:z.number().int().min(1).max(100).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },async({query,limit=50})=>{try{const x=await providerSearch(semanticUrl,query,"Contacts");return result({state:"ACHIEVED",provider:"wechat",query,provider_visible_state_changed:x.provider_visible_state_changed,contacts:x.results.filter(v=>v.category==="Contacts"||v.category==="Unknown").slice(0,limit)});}catch(error){return failure(error,"WECHAT_CONTACT_SEARCH_FAILED");}});

  server.registerTool("wechat_message_search",{
    title:"Search WeChat chat history",description:"Use WeChat's bounded search UI and return Chat History result rows when the provider exposes them. Does not claim full history if WeChat omits results.",
    inputSchema:{query:z.string().trim().min(1).max(128),limit:z.number().int().min(1).max(100).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true},
  },async({query,limit=50})=>{try{const x=await providerSearch(semanticUrl,query,"Search");return result({state:"ACHIEVED",provider:"wechat",query,complete:false,provider_visible_state_changed:x.provider_visible_state_changed,matches:x.results.filter(v=>v.category==="Chat History").slice(0,limit)});}catch(error){return failure(error,"WECHAT_MESSAGE_SEARCH_FAILED");}});

  server.registerTool("wechat_selected_conversation",{
    title:"Read selected WeChat conversation",description:"Read the currently selected conversation without navigation.",inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async()=>{try{const x=await currentConversations(semanticUrl);const selected=x.conversations.filter(v=>v.selected);if(selected.length>1)throw codedError("WECHAT_SELECTED_CONVERSATION_AMBIGUOUS");return result({state:"ACHIEVED",provider:"wechat",conversation:selected[0]||null});}catch(error){return failure(error,"WECHAT_SELECTED_CONVERSATION_FAILED");}});

  server.registerTool("wechat_chat_view",{
    title:"View one WeChat chat",description:"Select one exact WeChat target and return the current viewport as an image. Default fail-closed behavior refuses selections that may mark an unread chat read; set allow_mark_read=true only when that provider-visible read effect is intended.",
    inputSchema:{target:z.string().trim().min(1).max(256),allow_mark_read:z.boolean().optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async({target,allow_mark_read=false})=>{try{const selection=await postJson(semanticUrl,"/select-target",{target,allow_mark_read},"WECHAT_CHAT_SELECT_FAILED",12000);const bytes=await getBinary(semanticUrl+"/screenshot","WECHAT_SCREENSHOT_UNAVAILABLE");return{structuredContent:{state:"ACHIEVED",provider:"wechat",selection,read_state_may_change:Boolean(selection?.would_mark_read),mime_type:"image/png",byte_length:bytes.length},content:[{type:"text",text:JSON.stringify({state:"ACHIEVED",provider:"wechat",selection,read_state_may_change:Boolean(selection?.would_mark_read)},null,1)},{type:"image",data:bytes.toString("base64"),mimeType:"image/png"}]};}catch(error){return failure(error,"WECHAT_CHAT_VIEW_FAILED");}});

  server.registerTool("wechat_screenshot",{
    title:"Capture WeChat screenshot",description:"Capture the current private WeChat viewport without navigation.",inputSchema:{},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async()=>{try{const bytes=await getBinary(semanticUrl+"/screenshot","WECHAT_SCREENSHOT_UNAVAILABLE");return{structuredContent:{state:"ACHIEVED",provider:"wechat",mime_type:"image/png",byte_length:bytes.length},content:[{type:"image",data:bytes.toString("base64"),mimeType:"image/png"}]};}catch(error){return failure(error,"WECHAT_SCREENSHOT_FAILED");}});

  server.registerTool("wechat_send",{
    title:"Send WeChat text",description:"Send text to one exact WeChat target through the bounded official-client composer. No same-runtime UI result is accepted as provider confirmation; success remains ACKNOWLEDGED_UNVERIFIED. Default refuses selecting an unread chat unless allow_mark_read=true.",
    inputSchema:{target:z.string().trim().min(1).max(256),text:z.string().min(1).max(100000),allow_mark_read:z.boolean().optional(),dry_run:z.boolean().optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async(input)=>{try{return result(await postJson(semanticUrl,"/send-text",input,"WECHAT_SEND_FAILED",20000));}catch(error){return failure(error,"WECHAT_SEND_FAILED");}});

  const actionTool=(name,title,action,schema={})=>server.registerTool(name,{
    title,description:"Use the exact WeChat conversation context action. Any mutation is acknowledged but remains unverified because no independent provider-fresh verifier exists.",
    inputSchema:{target:z.string().trim().min(1).max(256),...schema,dry_run:z.boolean().optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async(input)=>{try{return result(await postJson(semanticUrl,"/conversation-action",{...input,action},"WECHAT_CONVERSATION_ACTION_FAILED",12000));}catch(error){return failure(error,"WECHAT_CONVERSATION_ACTION_FAILED");}});
  actionTool("wechat_mark_read","Mark WeChat conversation read","mark_read");
  actionTool("wechat_mark_unread","Mark WeChat conversation unread","mark_unread");
  actionTool("wechat_mute","Mute or unmute WeChat conversation","mute",{desired:z.boolean()});
  actionTool("wechat_pin","Pin or unpin WeChat conversation","pin",{desired:z.boolean()});

}
