// Shared outgoing TEXT admission: source-grounded colloquial drafting by the
// SAME Dexa writer, not a hidden model pass or a provider-specific automaton.
// This module deliberately does NOT execute or send anything.
import {catalogRoute,inputSchemaFor} from './dexa_catalog_registry.mjs';
import {DEXA_TEXT_WRITER_ID} from './dexa_text_writer_v1.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code})};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const quoteMarkers=/(?:دقیق(?:اً|ا)|عین(?:\s+عبارت|\s+همین)|کلمه\s+به\s+کلمه|مو\s+به\s+مو|بدون\s+تغییر|verbatim|exact(?:ly)?|word\s+for\s+word)/iu;
const quoteContent=/(?:«([^«»]{1,5000})»|“([^“”]{1,5000})”|"([^"]{1,5000})")/gu;
const sendRoute=/(?:^|_)(?:telegram|whatsapp|wechat|alibaba|bale|android_sms|email|gmail|mail)_(?:send|reply)$/i;
export function explicitVerbatimOwnerLiterals(goal){
 if(typeof goal!=='string'||!quoteMarkers.test(goal))return [];
 return [...goal.matchAll(quoteContent)].map(m=>m[1]??m[2]??m[3]);
}
export function validateWriterBackedOutgoingTextStep(step,{steps=[],ownerGoal=''}={}){
 if(step?.kind!=='TOOL')return false;
 const route=catalogRoute(step.capabilityId);
 if(!route?.cfName||!sendRoute.test(route.cfName)||route.isReadOnly)return false;
 const fields=Object.keys(inputSchemaFor(step.capabilityId)?.properties||{});
 const contentKey=fields.includes('text')?'text':fields.includes('body')?'body':null;
 if(!contentKey)return false;
 const value=step.args?.[contentKey];
 if(value===undefined)return false; // existing required-argument validation.
 if(typeof value==='string'){
  if(explicitVerbatimOwnerLiterals(ownerGoal).includes(value))return true;
  fail('DEXA_OUTGOING_UNDRAFTED_LITERAL_FORBIDDEN');
 }
 if(!obj(value)||!obj(value.$ref)||
    Object.keys(value).length!==1||Object.keys(value.$ref).length!==2)
  fail('DEXA_OUTGOING_WRITER_REF_REQUIRED');
 const ref=value.$ref;
 if(!Number.isSafeInteger(ref.step)||ref.step<1||
    JSON.stringify(ref.path)!=='["text"]')
  fail('DEXA_OUTGOING_WRITER_REF_REQUIRED');
 const source=steps.find(s=>s.id===ref.step);
 if(source?.kind!=='TOOL'||source.capabilityId!==DEXA_TEXT_WRITER_ID||
    !Array.isArray(step.deps)||!step.deps.includes(ref.step)||
    !['draft','rewrite','translate','proofread','change_tone'].includes(source.args?.operation))
  fail('DEXA_OUTGOING_WRITER_STEP_REQUIRED');
 return true;
}
