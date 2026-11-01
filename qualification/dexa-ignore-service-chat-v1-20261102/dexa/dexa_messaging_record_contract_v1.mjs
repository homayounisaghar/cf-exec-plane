// Dexa messaging ingress v1: one deterministic output family for all admitted
// messenger reads. The provider-owned native result remains intact: this is
// an additive, receipt-bound projection, never a new provider invocation.
// Keep every adapter-specific field lookup HERE, not in Rana's planner,
// answer formatter, identity resolver, or writer.
export const DEXA_MESSAGING_RECORD_SCHEMA='dexa.messaging-record.v1';
const PROVIDERS=new Set(['telegram','whatsapp','bale','alibaba','wechat']);

// Owner's temporary Dexa display preference: treat the exact WeChat system
// chat as outside the discoverable chat population. This is NOT a provider
// deletion, read, chat navigation, or mutation. Preserve underlying provider
// records; derive a filtered view before any typed DAG step can consume them.
const WECHAT_DISCOVERY_FIELDS=Object.freeze({
 wechat_conversation_list:['conversations'],
 wechat_unread_list:['conversations'],
 wechat_conversation_search:['conversations','results','hits'],
 wechat_contact_search:['contacts','results','hits'],
 wechat_message_search:['messages','results','hits']
});
const ignoredWeChatLabel='service notifications';
const normalizedChatLabel=value=>typeof value==='string'?
 value.normalize('NFKC').trim().toLocaleLowerCase('en'):null;
const matchesIgnoredLabel=value=>
 normalizedChatLabel(value)===ignoredWeChatLabel;
const ignoredWeChatRow=(row,nativeTool)=>{
 if(!row||typeof row!=='object'||Array.isArray(row))return false;
 // A message search hit can have an unrelated text/title; check only its
 // observed conversation identity. Chat/contact lists use their row name.
 const fields=nativeTool==='wechat_message_search'?
  ['conversation_name','chat_name','conversation_title','chat_title']:
  ['name','display_name','title','conversation_name','chat_name'];
 return fields.some(field=>matchesIgnoredLabel(row[field]));
};
export function excludeDexaWeChatServiceChat({nativeTool,result,readOnly}={}){
 const fields=WECHAT_DISCOVERY_FIELDS[nativeTool];
 if(readOnly!==true||!fields||!result||typeof result!=='object'||
    Array.isArray(result)||!TERMINAL.has(String(result.state||'')))
  return result;
 let out=result,changed=false;
 for(const key of fields){
  const original=result[key];
  if(!Array.isArray(original))continue;
  const retained=original.filter(row=>!ignoredWeChatRow(row,nativeTool));
  if(retained.length===original.length)continue;
  if(!changed){out={...result};changed=true}
  out[key]=retained;
  // Keep bounded returned-row counters aligned with the owner-visible view;
  // do not rewrite unrelated global-count estimates or completeness flags.
  for(const countKey of ['count','returned']){
   if(Number.isSafeInteger(result[countKey])&&
      result[countKey]===original.length)out[countKey]=retained.length;
  }
 }
 return out;
}
const TERMINAL=new Set(['ACHIEVED','SUCCEEDED','COMPLETED']);
const MAX_ROWS=100, MAX_VIEW_CHARS=160000;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const validString=x=>typeof x==='string'&&x.trim().length>0;
const text=x=>typeof x==='string'?x:'';
const str=x=>validString(x)?x.trim():null;
const positive=x=>Number.isSafeInteger(x)&&x>0?x:null;
const bool=x=>typeof x==='boolean'?x:null;
const safeLabel=x=>{
 const v=str(x);
 return v&&v.length<=250&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(v)?v:null;
};
const first=(record,keys)=>keys.map(k=>record?.[k]).find(v=>v!==undefined&&v!==null);
function routedNative(nativeTool){
 if(typeof nativeTool!=='string')return null;
 const m=/^(telegram|whatsapp|bale|alibaba|wechat)_(conversation_(?:list|search)|selected_conversation|message_(?:list|get|search|replies)|unread_list)$/.exec(nativeTool);
 if(!m||!PROVIDERS.has(m[1]))return null;
 return {provider:m[1],family:m[2].startsWith('message_')?'messages':'conversations',nativeTool};
}
const MEDIA_KINDS=new Set(['image','video','audio','voice','file','gif','sticker','animation','video_note']);
function kindFrom(value){
 const k=str(value)?.toLowerCase();
 if(!k)return null;
 if(['image','photo','picture'].includes(k))return 'image';
 if(['voice','ptt','voice_message'].includes(k))return 'voice';
 if(['video','movie'].includes(k))return 'video';
 if(['audio','music'].includes(k))return 'audio';
 if(['document','file','application'].includes(k))return 'file';
 if(['gif','animation'].includes(k))return 'gif';
 if(k.includes('sticker'))return 'sticker';
 if(['video_note','round_video'].includes(k))return 'video_note';
 return MEDIA_KINDS.has(k)?k:null;
}
function kindFromMime(mime){
 const m=str(mime)?.toLowerCase();
 if(!m)return null;
 if(m.startsWith('image/'))return 'image';
 if(m.startsWith('video/'))return 'video';
 if(m.startsWith('audio/'))return 'audio';
 if(m==='application/pdf'||m.startsWith('application/'))return 'file';
 return null;
}
function suffixKind(suffix){
 const ext=str(suffix)?.replace(/^\./,'').toLowerCase();
 if(['jpg','jpeg','png','webp','bmp','heic'].includes(ext))return 'image';
 if(['gif'].includes(ext))return 'gif';
 if(['mp4','mov','avi','webm'].includes(ext))return 'video';
 if(['mp3','ogg','wav','m4a','opus'].includes(ext))return 'audio';
 if(['pdf','doc','docx','txt','zip','xlsx'].includes(ext))return 'file';
 return null;
}
function attachmentList(row){
 const raw=Array.isArray(row.attachments)?row.attachments:
  object(row.attachment)?[row.attachment]:[];
 return raw.slice(0,30).filter(object).map(a=>{
  const mime=str(first(a,['mime_type','media_type','mimetype','mime']));
  const declared=kindFrom(first(a,['media_kind','type','kind']));
  const mimeKind=kindFromMime(mime);
  // "file" describes the transport container, not the bytes' media class.
  // Audited provider MIME outranks only this generic container label.
  // Specific kinds (GIF/animation/sticker/video_note/voice) retain their
  // provider semantics even when the underlying bytes are video/mp4.
  // A filename extension alone is never promoted over a known container.
  const k=(declared==='file'&&mimeKind&&mimeKind!=='file'?
    mimeKind:declared)||mimeKind||suffixKind(a.suffix);
  const name=safeLabel(first(a,['filename','name','file_name']));
  return {
   kind:k||'unknown',mime_type:mime,filename:name,
   size_bytes:positive(first(a,['size_bytes','size','file_size'])),
   provider_file_ref:str(first(a,['handle','file_id','attachment_id'])),
   width:positive(a.width),height:positive(a.height),
   content_verified:false
  };
 });
}
function normalizedTime(row,provider,{conversation=false}={}){
 const msFields=conversation?['last_activity_ms','last_date_ms']:
  ['timestamp_ms','date_ms'];
 let ms=positive(first(row,msFields)),precision=ms?'milliseconds':null;
 if(!ms&&!conversation){
  const date=positive(row.date);
  if(date&&date<=4102444800){ms=date*1000;precision='seconds'}
 }
 if(!ms&&provider==='wechat'&&Number.isSafeInteger(row.timestamp_ms)){
  ms=positive(row.timestamp_ms);precision=ms?'milliseconds':null;
 }
 if(ms&&ms>4102444800000){ms=null;precision=null}
 return {timestamp_ms:ms,iso_utc:ms?new Date(ms).toISOString():null,
  precision,display_time:provider==='wechat'?safeLabel(row.timestamp):null,
  time_verified:ms!==null};
}
function direction(row){
 const actual=first(row,['outgoing','from_me','is_outgoing','isOutgoing']);
 if(typeof actual==='boolean')return actual;
 const d=str(row.direction)?.toLowerCase();
 if(['outgoing','sent','outbound'].includes(d))return true;
 if(['incoming','received','inbound'].includes(d))return false;
 return null;
}
function sender(row){
 const rawLabel=safeLabel(first(row,['sender_name','author_name','from_name','display_sender']));
 const label=rawLabel&&/@(?:lid|c\.us|s\.whatsapp\.net|g\.us)$/iu.test(rawLabel)?
  null:rawLabel;
 const opaque=first(row,['sender_id','sender_ali_id','sender','author_id','from_id']);
 const senderId=(typeof opaque==='string'&&opaque.trim())?
  opaque.trim():Number.isSafeInteger(opaque)?String(opaque):null;
 return {display_name:label,provider_sender_id:senderId,
  display_name_is_provider_observed:label!==null,
  human_identity_verified:false};
}
function rawText(row){
 const nativeText=first(row,['text','message_text','body','content']);
 const caption=first(row,['caption'])??row.mediaData?.caption??null;
 let body=text(nativeText),c=text(caption);
 return {body,caption:c};
}
function opaqueEncodedMedia(v){
 return typeof v==='string'&&v.length>=128&&v.length%4===0&&
  /^[A-Za-z0-9+/]+={0,2}$/.test(v);
}
function nativeMessage(row,provider,tool){
 if(!object(row))throw Error('DEXA_CANONICAL_MESSAGE_NOT_OBJECT');
 const attachments=attachmentList(row);
 const mime=str(first(row,['media_type','mime_type','mimetype']));
 const detected=kindFrom(first(row,['type','media_kind','media_open_kind','kind']))||
   kindFromMime(mime)||attachments.find(a=>a.kind!=='unknown')?.kind||null;
 const explicit=bool(first(row,['has_media','has_attachment']));
 const hasMedia=explicit===true||attachments.length>0||mime!==null||detected!==null;
 const {body,caption}=rawText(row);
 // A media transport's opaque bytes are not textual evidence. A real
 // provider caption always takes precedence over a base64 payload.
 const cleanedCaption=caption&&!(hasMedia&&opaqueEncodedMedia(caption))?caption:null;
 const cleanedBody=hasMedia&&opaqueEncodedMedia(body)?'':body;
 const canonicalText=cleanedCaption??cleanedBody;
 const d=direction(row),t=normalizedTime(row,provider);
 const identification=sender(row);
 const handle=str(first(row,['handle','message_handle','message_ref']));
 const conversationHandle=str(first(row,['conversation_handle','chat_handle']));
 const deleted=bool(first(row,['revoked','recalled','deleted']));
 const edited=bool(row.edited);
 return {
  schema:DEXA_MESSAGING_RECORD_SCHEMA,provider,handle,
  conversation_handle:conversationHandle,
  text:canonicalText,caption:cleanedCaption,
  sender_name:identification.display_name,
  outgoing:d,from_me:d,
  timestamp_ms:t.timestamp_ms,date:t.timestamp_ms===null?null:Math.floor(t.timestamp_ms/1000),
  type:detected||kindFrom(row.type)||(deleted?'revoked':'text'),
  has_media:hasMedia,media_type:mime,attachments,
  identity:{sender:identification,conversation_handle:conversationHandle,
   conversation_display_name:null,conversation_identity_verified:Boolean(conversationHandle)},
  media:{present:hasMedia,kind:detected||'unknown',mime_type:mime,
   caption:cleanedCaption,attachments,content_verified:false},
  time:t,
  flags:{deleted,edited,outgoing:d},
  provenance:{source_native_tool:tool,provider_origin:'AUTHENTICATED_CF_READ',
   canonicalizer:DEXA_MESSAGING_RECORD_SCHEMA,transport_bytes_excluded:true}
 };
}
function nativeConversation(row,provider,tool){
 if(!object(row))throw Error('DEXA_CANONICAL_CONVERSATION_NOT_OBJECT');
 const handle=str(first(row,['handle','conversation_ref']));
 const label=['name','company_name','display_name','title']
  .map(k=>safeLabel(row[k])).find(Boolean)||null;
 const t=normalizedTime(row,provider,{conversation:true});
 const peerKind=safeLabel(first(row,['kind','type','peer_kind']));
 const unread=Number.isSafeInteger(row.unread_count)&&row.unread_count>=0?
  row.unread_count:null;
 return {
  schema:DEXA_MESSAGING_RECORD_SCHEMA,provider,
  handle,name:label,kind:peerKind,
  unread_count:unread,has_unread:bool(row.has_unread),
  timestamp_ms:t.timestamp_ms,last_activity_ms:t.timestamp_ms,
  identity:{conversation_handle:handle,display_name:label,
   provider_observed:Boolean(handle),human_identity_verified:false,
   addressable_with_handle:provider!=='wechat'&&Boolean(handle)},
  time:t,
  flags:{unread_count:unread,has_unread:bool(row.has_unread),
   pinned:bool(row.pinned),muted:bool(row.muted)},
  provenance:{source_native_tool:tool,provider_origin:'AUTHENTICATED_CF_READ',
   canonicalizer:DEXA_MESSAGING_RECORD_SCHEMA,
   provider_identity_strength:provider==='wechat'?str(row.identity_strength):null}
 };
}
export const CANONICAL_MESSAGE_ARRAY_SCHEMA=Object.freeze({family:'messages',
 fields:['schema','provider','handle','conversation_handle','text','caption',
  'sender_name','outgoing','from_me','timestamp_ms','date','type','has_media',
  'media_type','attachments','identity','media','time','flags','provenance'],
 fieldTypes:{schema:'string',provider:'string',handle:'string',
  conversation_handle:'string',text:'string',caption:'string',
  sender_name:'string',outgoing:'boolean',from_me:'boolean',
  timestamp_ms:'integer',date:'integer',type:'string',has_media:'boolean',
  media_type:'string'},
 optionalFields:['handle','conversation_handle','caption','sender_name',
  'outgoing','from_me','timestamp_ms','date','media_type']});
export const CANONICAL_CONVERSATION_ARRAY_SCHEMA=Object.freeze({family:'conversations',
 fields:['schema','provider','handle','name','kind','unread_count',
  'has_unread','timestamp_ms','last_activity_ms','identity','time','flags','provenance'],
 fieldTypes:{schema:'string',provider:'string',handle:'string',name:'string',
  kind:'string',unread_count:'integer',has_unread:'boolean',
  timestamp_ms:'integer',last_activity_ms:'integer'},
 optionalFields:['handle','kind','unread_count','has_unread','timestamp_ms','last_activity_ms']});
export function canonicalOutputShapeForRoute(nativeTool){
 const route=routedNative(nativeTool);
 if(!route)return null;
 // WeChat's current read-only message-search endpoint has not produced a
 // verified successful message result. The converter supports provider-shaped
 // future records, but the planner MUST NOT treat that unavailable operation
 // as an audited typed message source yet. Conversation observations work.
 if(route.provider==='wechat'&&route.family==='messages')return null;
 return {source:'DEXA_AUTHENTICATED_INGRESS_CANONICALIZER_V1',
  schema:DEXA_MESSAGING_RECORD_SCHEMA,
  arrayKey:route.family==='messages'?'canonical_messages':'canonical_conversations',
  arrayShape:route.family==='messages'?
   CANONICAL_MESSAGE_ARRAY_SCHEMA:CANONICAL_CONVERSATION_ARRAY_SCHEMA};
}
function observedRows(result,route){
 if(route.family==='messages'){
  if(Array.isArray(result.messages))return result.messages;
  if(object(result.message))return [result.message];
  if(result.message===null&&route.nativeTool.endsWith('_message_get'))return [];
  if(Array.isArray(result.replies)&&result.replies.every(object))return result.replies;
  if(Array.isArray(result.results)&&result.results.every(object))return result.results;
  if(Array.isArray(result.hits)&&result.hits.every(object))return result.hits;
  return null;
 }
 if(Array.isArray(result.conversations))return result.conversations;
 if(object(result.conversation)&&route.nativeTool.endsWith('_selected_conversation'))
  return [result.conversation];
 return null;
}
export function attachCanonicalMessagingView({nativeTool,result,readOnly}={}){
 const route=routedNative(nativeTool);
 if(!route||readOnly!==true||!object(result)||
    !TERMINAL.has(String(result.state||'')))return result;
 const rows=observedRows(result,route);
 if(rows===null||rows.length>MAX_ROWS||!rows.every(object))return result;
 // A provider search can return generic UI hits, not actual message rows.
 // Only promote records with a provider-observed text/media/message identity
 // field. No synthetic empty messages from an unrelated search result.
 if(route.family==='messages'&&rows.some(row=>
    !['text','message_text','body','content','caption','handle',
      'message_handle','message_ref','attachments','attachment','media_type',
      'has_media','type','kind'].some(k=>row[k]!==undefined&&row[k]!==null)))
  return result;
 try{
  const records=rows.map(row=>route.family==='messages'?
   nativeMessage(row,route.provider,nativeTool):
   nativeConversation(row,route.provider,nativeTool));
  const payload=JSON.stringify(records);
  if(payload.length>MAX_VIEW_CHARS)return result;
  const key=route.family==='messages'?'canonical_messages':'canonical_conversations';
  return {...result,[key]:records,canonical_meta:{
   schema:DEXA_MESSAGING_RECORD_SCHEMA,provider:route.provider,
   source_native_tool:nativeTool,record_family:route.family,
   observed_count:records.length,provider_result_count:
    Number.isSafeInteger(result.count)?result.count:null,
   native_ordering:safeLabel(result.ordering),
   bounded_result:true,full_population_verified:false,
   source_read_state_changed:typeof result.read_state_changed==='boolean'?
    result.read_state_changed:null,
   no_additional_provider_reads:true,content_not_media_verified:true
  }};
 }catch{return result} // fail closed for canonical paths; preserve native paths
}
