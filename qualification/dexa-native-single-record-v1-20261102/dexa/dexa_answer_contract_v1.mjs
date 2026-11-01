// Owner-facing answer delivery contract, executed inside Rana after receipts
// and postconditions. This is deterministic typed projection, not a second
// language-model evaluation, speculative plan or untrusted raw-JSON fallback.
import {createHash} from "node:crypto";
import {renderVerifiedMessageOutput,renderVerifiedConversationOutput}
 from "./dexa_verified_record_renderers_v1.mjs";
export const ANSWER_CONTRACT_SCHEMA="dexa.answer-delivery.v1";
const fail=code=>{throw Object.assign(new Error(code),{code})};
const digest=data=>createHash("sha256").update(JSON.stringify(data)).digest("hex");
const cleanString=x=>x.normalize("NFC")
 .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,"")
 .trim();
// A grouped read-EACH result is a provider-record pair, not a model-provided
// group label or invented message. Reject channels, users, missing timestamps,
// hidden IDs and unverified message bodies. Scope is always the bounded set
// actually consulted; never assert global coverage of every Telegram group.
export function renderVerifiedGroupMessage(output){
 if(!output||typeof output!=="object"||Array.isArray(output)||
    !output.source||!output.response||
    !["group","supergroup"].includes(output.source.kind))
  fail("TOOL_ANSWER_GROUP_KIND_NOT_VERIFIED");
 const title=typeof output.source.name==="string"?
  cleanString(output.source.name).replace(/\s+/gu," ").slice(0,180):"";
 if(!title)fail("TOOL_ANSWER_GROUP_NAME_NOT_VERIFIED");
 const messages=output.response.messages;
 if(!Array.isArray(messages)||messages.length!==1)
  fail("TOOL_ANSWER_GROUP_MESSAGE_NOT_VERIFIED");
 const message=messages[0];
 if(!message||!Number.isSafeInteger(message.date)||message.date<=0||
    message.date>4102444800)
  fail("TOOL_ANSWER_GROUP_MESSAGE_DATE_NOT_VERIFIED");
 if(!Number.isSafeInteger(output.checkedCount)||output.checkedCount<1||
    output.checkedCount>50)
  fail("TOOL_ANSWER_GROUP_SCOPE_NOT_VERIFIED");
 const content=renderVerifiedMessageOutput(messages);
 // Evidence still proves full bounded coverage and compares message.date,
 // but do not add unsolicited counts or timestamp fields to the owner reply.
 return "جدیدترین پیام پیدا‌شده در گروه‌های گفت‌وگوهای اخیر:\nگروه: "+
  title+"\n"+content;
}
// All meanings are bound to a proven output field and trusted tool ancestry
// in parseTypedPlan. The model cannot author free-text true/false labels.
export function deliverTypedAnswer({answer,output,format,emptyCollectionContext=null,
 verifiedNativeMessageBody=false,boundedVisibleMessages=false}){
 if(answer===undefined||answer===null){
  // Legacy programs may return self-describing text/objects/arrays, but an
  // unlabeled boolean is NOT an independently meaningful owner's answer.
  if(typeof output==="boolean")
   fail("TOOL_ANSWER_CONTRACT_REQUIRED_FOR_BOOLEAN");
  const value=format==="text"&&typeof output==="string"?
   cleanString(output):JSON.stringify(output,null,2);
  if(typeof value!=="string"||!value.trim()||value.length>25000)
   fail("TOOL_FINAL_OUTPUT_EMPTY_OR_OVERSIZE");
  return {text:value,proof:{schema:ANSWER_CONTRACT_SCHEMA,
   verified:false,reason:"LEGACY_UNDECLARED_SEMANTICS"}};
 }
 let text;
 switch(answer.kind){
  case "sender_role":
   if(typeof output!=="boolean")fail("TOOL_ANSWER_EXPECTS_BOOLEAN");
   text=output?"آخرین پیام را خودت فرستاده‌ای.":"آخرین پیام را طرف مقابل فرستاده است.";
   break;
  case "count":
   if(!Number.isSafeInteger(output)||output<0)
    fail("TOOL_ANSWER_EXPECTS_COUNT");
   text="تعداد: "+output.toLocaleString("fa-IR");
   break;
  case "messages":{
   // The typed executor has already authenticated the physical producer,
   // checked the output path against audited catalog metadata and proved
   // the provider's native message body field is a string. A deterministic
   // one-field presentation alias is safe; NEVER infer sender or timestamps.
   const presentable=verifiedNativeMessageBody?
    Array.isArray(output)?output.map(row=>({...row,text:row.body})):
     {...output,text:output.body}:output;
   text=renderVerifiedMessageOutput(presentable);
   if(boundedVisibleMessages)
    text="پیام‌های قابل‌مشاهده در محدودهٔ بررسی‌شده (تازه‌ترین پیام کل گفت‌وگو تأیید نشده است):\n"+text;
   if(verifiedNativeMessageBody&&
      (Array.isArray(output)?
       output.some(row=>row?.body_may_be_truncated===true):
       output?.body_may_be_truncated===true))
    text+="\n[بخشی از متن پیام‌ها در نمای پیام‌رسان کوتاه شده است.]";
   break;
  }
  case "group_message":text=renderVerifiedGroupMessage(output);break;
  case "conversations":
   text=emptyCollectionContext==='verified_unread'&&
    Array.isArray(output)&&output.length===0?
    'در محدودهٔ بررسی‌شده، گفت‌وگوی دارای پیام خوانده‌نشده پیدا نشد.':
    renderVerifiedConversationOutput(output);
   break;
  case "text":
   if(typeof output!=="string")fail("TOOL_ANSWER_EXPECTS_TEXT");
   text=cleanString(output);
   break;
  case "json":
   // Raw, strictly verified provider results are a faithful cross-provider
   // fallback when no domain-specific prose renderer exists. This does not
   // imply that a planned semantic inference has been independently proven.
   if(output===undefined||output===null||typeof output!=="object"||
      Array.isArray(output)&&!output.length)
    fail("TOOL_ANSWER_EXPECTS_JSON_RECORDS");
   text=JSON.stringify(output,null,2);
   break;
  default:fail("TOOL_ANSWER_KIND_INVALID");
 }
 if(typeof text!=="string"||!text.trim()||text.length>25000)
  fail("TOOL_ANSWER_DELIVERY_UNVERIFIED");
 return {text,proof:{
  schema:ANSWER_CONTRACT_SCHEMA,verified:true,kind:answer.kind,
  outputDigest:digest(output),textDigest:digest(text),
  evidence:"RANA_TYPE_AND_PROVIDER_GROUNDED_PROJECTION"
 }};
}
