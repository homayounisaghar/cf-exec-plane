// Provider-neutral, fail-closed identity dependency closure for a typed Rana DAG.
// Model-authored literal conversation selectors are not credentials.
// The only allowed closure is a SELECTED, same-provider, read-only lookup
// followed by a unique MATCH. Native exact-label writes additionally require
// an audited send-input contract, explicit literal owner designation, and an
// independent recipient-uniqueness check by the native provider tool.
// This module never calls providers, chooses alternate capabilities, sends,
// or performs free-form Persian intent parsing.
import {catalogRoute,inputSchemaFor} from './dexa_catalog_registry.mjs';
import {catalogKnownOutputShape} from './dexa_catalog_output_adapters_v1.mjs';
import {sameWholeIdentityLabelOrthography}
 from './dexa_scoped_name_match.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const CONTROL=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const LABEL=/[\p{L}\p{N}]/u;
const CF_NAMESPACE=n=>{
 const cf=catalogRoute(n)?.cfName;
 return typeof cf==='string'&&cf.includes('_')?cf.slice(0,cf.indexOf('_')):null;
};
const safeLabel=s=>typeof s==='string'&&s.trim()===s&&
 s.length>=2&&s.length<=120&&LABEL.test(s)&&!CONTROL.test(s)&&
 !s.includes('://')&&!s.includes('/')&&!s.includes('\\')&&
 !/^[\w.-]+:[^\s]+$/u.test(s);

// Only exact *owner-provided* recipient names may be resolved for writes.
// This is a lexical proof of explicit designation, not an NLP guess.
function ownerDesignatedLabel(goal,label){
 if(typeof goal!=='string'||goal.length>12000||!safeLabel(label))return false;
 const full=goal.normalize('NFKC').toLocaleLowerCase('en');
 const key=label.normalize('NFKC').toLocaleLowerCase('en');
 let at=0;
 while((at=full.indexOf(key,at))!==-1){
  const before=at?full[at-1]:'',after=full[at+key.length]||'';
  if(!/[\p{L}\p{N}]/u.test(before)&&
     !/[\p{L}\p{N}]/u.test(after))return true;
  at++;
 }
 return false;
}
function sourceIdentityContract(lookupId,{field,arrayKey}){
 const route=catalogRoute(lookupId),shape=catalogKnownOutputShape(lookupId);
 const source=shape?.arrays?.[arrayKey];
 return route?.isReadOnly===true&&route.requiresElevation!==true&&
  typeof route.cfName==='string'&&
  /_conversation_(search|list)$/.test(route.cfName)&&
  !arrayKey.startsWith('canonical_')&&
  Array.isArray(source?.fields)&&source.fields.includes('name')&&
  source.fields.includes(field)&&
  source.fieldTypes?.[field]==='string'&&
  source.fieldTypes?.name==='string';
}
function selectKnownLookup(consumerId,allowed,{field='handle',
 arrayKey=null,nativeOnly=false}={}){
 const ns=CF_NAMESPACE(consumerId),permitted=new Set(allowed);
 if(!ns)return null;
 const candidates=[];
 for(const id of permitted){
  const route=catalogRoute(id);
  if(!route?.isReadOnly||route.requiresElevation||!route.cfName||
     CF_NAMESPACE(id)!==ns||id===consumerId)continue;
  const suffix=route.cfName.slice(ns.length);
  const tier=suffix==='_conversation_search'?0:
   suffix==='_conversation_list'?1:null;
  if(tier===null)continue;
  const schema=inputSchemaFor(id);
  if(!schema||!object(schema.properties))continue;
  const arrays=catalogKnownOutputShape(id)?.arrays||{};
  const entries=Object.entries(arrays).filter(([key,row])=>
   (!arrayKey||key===arrayKey)&&(!nativeOnly||!key.startsWith('canonical_'))&&
   Array.isArray(row?.fields)&&row.fields.includes('name')&&
   row.fields.includes(field)&&row.fieldTypes?.[field]==='string');
  const native=entries.filter(([key])=>!key.startsWith('canonical_'));
  const canonical=entries.filter(([key])=>key.startsWith('canonical_'));
  const selected=native.length===1?native[0]:
   native.length===0&&canonical.length===1&&!nativeOnly?canonical[0]:null;
  if(!selected)continue;
  const [collection]=selected;
  if(nativeOnly&&!sourceIdentityContract(id,{field,arrayKey:collection}))continue;
  if(tier===0){
   if(schema.properties.query?.type!=='string'||
      !Array.isArray(schema.required)||
      schema.required.some(k=>k!=='query'))continue;
  }else if((schema.required||[]).length>0)continue;
  const args=tier===0?{query:null}:{};
  const lim=schema.properties.limit;
  if(lim?.type==='integer'){
   const max=Number.isSafeInteger(lim.maximum)?lim.maximum:40;
   const min=Number.isSafeInteger(lim.minimum)?lim.minimum:1;
   args.limit=Math.max(min,Math.min(40,max));
  }
  if(tier===1&&nativeOnly&&schema.properties.max_pages?.type==='integer'){
   const max=schema.properties.max_pages.maximum;
   args.max_pages=Math.min(Number.isSafeInteger(max)?max:2,2);
  }
  candidates.push({id,tier,args,arrayKey:collection});
 }
 candidates.sort((a,b)=>a.tier-b.tier||a.id.localeCompare(b.id));
 if(!candidates.length||
  (candidates.length>1&&candidates[0].tier===candidates[1].tier))
  return null;
 return candidates[0];
}
const remapRefs=(value,map,depth=0)=>{
 if(depth>10||!value||typeof value!=='object')return;
 if(Array.isArray(value)){
  for(const v of value)remapRefs(v,map,depth+1);return;
 }
 if(object(value.$ref)&&Number.isSafeInteger(value.$ref.step)){
  value.$ref.step=map.get(value.$ref.step)??value.$ref.step;
  return;
 }
 for(const v of Object.values(value))remapRefs(v,map,depth+1);
};
function resolveNativeWriteDescriptor(step,field,label,goal){
 const route=catalogRoute(step.capabilityId);
 const policy=catalogKnownOutputShape(step.capabilityId)
  ?.identityInputs?.[field];
 if(route?.isReadOnly!==false||step.mode!==undefined||
  policy?.kind!=='NATIVE_UNIQUE_EXACT_LABEL'||
  policy.nativeOperationVerifiesUniqueExactRecipient!==true||
  policy.neverTrustCanonicalIdentityForWrite!==true||
  policy.sourceRecordFamily!=='conversation'||
  policy.sourceField!=='name'||
  policy.sourceCollection!=='conversations'||
  !policy.requiredMatchModes?.includes('normalized_exact')||
  inputSchemaFor(step.capabilityId)?.properties?.[field]?.type!=='string'||
  !ownerDesignatedLabel(goal,label))return null;
 return {kind:'native_write',field,label,consumerId:step.id,
  fieldName:policy.sourceField,arrayKey:policy.sourceCollection,
  matchMode:'normalized_exact'};
}
function existingExactNativeMatch(doc,request){
 for(const step of doc.steps){
  if(step.id>=request.consumerId||step.kind!=='TRANSFORM'||
   step.op!=='MATCH'||
   !['normalized_exact','bilingual_exact'].includes(step.mode)||
   !sameWholeIdentityLabelOrthography(step.query,request.label)||
   JSON.stringify(step.fields)!==
    JSON.stringify([[request.fieldName]])||
   JSON.stringify(step.source?.path)!==
    JSON.stringify([request.arrayKey]))continue;
  const source=doc.steps.find(x=>x.id===step.source?.step);
  if(source?.kind!=='TOOL'||
   CF_NAMESPACE(source.capabilityId)!==CF_NAMESPACE(
    doc.steps[request.consumerId-1].capabilityId)||
   !sourceIdentityContract(source.capabilityId,{
    field:request.fieldName,arrayKey:request.arrayKey}))continue;
  return step.id;
 }
 return null;
}
function bindMatch(doc,req,matchId){
 const consumer=doc.steps.find(s=>s.id===req.consumerId);
 if(!consumer||!Array.isArray(consumer.deps)||matchId>=consumer.id)return false;
 consumer.args[req.field]={$ref:{step:matchId,path:[req.fieldName]}};
 if(!consumer.deps.includes(matchId))consumer.deps.push(matchId);
 consumer.deps.sort((a,b)=>a-b);
 return true;
}
function insertObservedMatch(doc,req,lookup){
 if(doc.steps.length+2>18)return false;
 const insertAt=req.consumerId;
 const oldToNew=new Map(doc.steps.map(s=>[s.id,
  s.id+(s.id>=insertAt?2:0)]));
 for(const step of doc.steps){
  step.id=oldToNew.get(step.id);
  if(Array.isArray(step.deps))
   step.deps=step.deps.map(x=>oldToNew.get(x)??x);
  if(Array.isArray(step.after))
   step.after=step.after.map(x=>oldToNew.get(x)??x);
  if(object(step.source)&&Number.isSafeInteger(step.source.step))
   step.source.step=oldToNew.get(step.source.step)??step.source.step;
  if(step.args)remapRefs(step.args,oldToNew);
  if(step.predicate)remapRefs(step.predicate,oldToNew);
 }
 if(Number.isSafeInteger(doc.output?.step))
  doc.output.step=oldToNew.get(doc.output.step)??doc.output.step;
 for(const row of Array.isArray(doc.checks)?doc.checks:[])
  if(Number.isSafeInteger(row?.step))
   row.step=oldToNew.get(row.step)??row.step;
 for(const row of Array.isArray(doc.outputs)?doc.outputs:[])
  if(Number.isSafeInteger(row?.step))
   row.step=oldToNew.get(row.step)??row.step;
 const lookupArgs={...lookup.args};
 if(lookup.tier===0)lookupArgs.query=req.label;
 const first={id:insertAt,kind:'TOOL',capabilityId:lookup.id,
  args:lookupArgs,deps:[]};
 const second={id:insertAt+1,kind:'TRANSFORM',op:'MATCH',
  source:{step:insertAt,path:[lookup.arrayKey]},
  query:req.label,fields:[['name']],mode:req.matchMode,
  deps:[insertAt]};
 doc.steps.splice(insertAt-1,0,first,second);
 const mappedReq={...req,consumerId:oldToNew.get(req.consumerId)};
 return bindMatch(doc,mappedReq,insertAt+1);
}
// A model may select the read-only, canonical conversation projection as a
// *read* candidate and then (incorrectly) try to use its name for a WRITE.
// Canonical projections never authorize writes. If the model explicitly
// selected an exact unique MATCH for the owner's actual recipient label,
// mechanically rebind that *read-only* observation to an independently audited
// SAME-provider native list that Kata ALREADY selected. This is a semantic
// no-op on the owner's target, not permission to trust the canonical record.
// No write args, target labels, send effects or model intent are synthesized.
function rebindCanonicalNativeWrite(doc,allowed,ownerGoal){
 const rules=[];
 const steps=doc.steps;
 for(const send of steps){
  if(send?.kind!=='TOOL'||catalogRoute(send.capabilityId)?.isReadOnly!==false)
   continue;
  const selectors=catalogKnownOutputShape(send.capabilityId)?.identityInputs||{};
  for(const [field,policy] of Object.entries(selectors)){
   const link=send.args?.[field]?.$ref;
   if(!object(link)||!Number.isSafeInteger(link.step)||
      JSON.stringify(link.path)!==JSON.stringify([policy.sourceField])||
      policy.kind!=='NATIVE_UNIQUE_EXACT_LABEL'||
      policy.nativeOperationVerifiesUniqueExactRecipient!==true||
      policy.neverTrustCanonicalIdentityForWrite!==true||
      policy.sourceCollection!=='conversations'||policy.sourceField!=='name')
    continue;
   const match=steps.find(x=>x.id===link.step);
   if(match?.kind!=='TRANSFORM'||match.op!=='MATCH'||
      !policy.requiredMatchModes?.includes(match.mode)||
      JSON.stringify(match.fields)!=='[["name"]]'||
      JSON.stringify(match.source?.path)!=='["canonical_conversations"]')continue;
   // A native read-navigation operation can change an unread badge, but
   // it is NOT a recipient write. It still rechecks the exact chat label
   // in the provider UI. Actual sends/mutations keep their owner-designated
   // recipient constraint and never gain this exception.
   const navigationRead=policy.notARecipientWrite===true&&
     policy.readStateMayChange===true&&
     policy.sourceRecordFamily==='conversation'&&
     inputSchemaFor(send.capabilityId)?.properties?.[field]?.type==='string';
   if(!navigationRead&&!ownerDesignatedLabel(ownerGoal,match.query))
    continue;
   const producer=steps.find(x=>x.id===match.source?.step);
   const upstream=catalogRoute(producer?.capabilityId);
   if(producer?.kind!=='TOOL'||producer.mode!==undefined||
      upstream?.isReadOnly!==true||upstream.requiresElevation||
      CF_NAMESPACE(producer.capabilityId)!==CF_NAMESPACE(send.capabilityId)||
      !/_conversation_(search|list)$/.test(upstream.cfName||'')||
      !catalogKnownOutputShape(producer.capabilityId)
       ?.arrays?.canonical_conversations?.fields?.includes('name')||
      typeof producer.args?.query==='string'&&
       !sameWholeIdentityLabelOrthography(producer.args.query,match.query))
    continue;
   if(navigationRead){
    // The model may choose a read-only SEARCH with a canonical alias,
    // but the provider's generic search results do not carry a native
    // conversations[] contract. For native navigation, mechanically
    // substitute an already SELECTED same-provider audited list instead.
    // The model's exact MATCH title stays unchanged and must pass the
    // native list's uniqueness proof. No guess, send, or new authority.
    const shape=catalogKnownOutputShape(producer.capabilityId);
    const shared=steps.some(other=>other.id!==match.id&&
      other.id!==producer.id&&other.id!==send.id&&(
       other.source?.step===producer.id||
       other.deps?.includes(producer.id)||
       JSON.stringify(other.args||{}).includes('"step":'+producer.id)||
       other.source?.step===match.id||
       other.deps?.includes(match.id)||
       JSON.stringify(other.args||{}).includes('"step":'+match.id)));
    if(!shape?.arrays?.canonical_conversations?.fields?.includes('name')||
       !allowed.includes(producer.capabilityId)||shared||
       [producer.id,match.id].includes(doc.output?.step)||
       (doc.checks||[]).some(x=>[producer.id,match.id].includes(x.step)))
      continue;
    if(!shape?.arrays?.conversations?.fields?.includes('name')){
     const lookup=selectKnownLookup(send.capabilityId,allowed,{
      field:'name',arrayKey:'conversations',nativeOnly:true});
     if(!lookup||lookup.tier!==1)continue;
     producer.capabilityId=lookup.id;
     producer.args={...lookup.args};
     rules.push('VERIFIED_NAVIGATION_NATIVE_LOOKUP_REBIND');
    }else{
     rules.push('VERIFIED_NAVIGATION_NATIVE_NAME_SOURCE_REBIND');
    }
    match.source.path=['conversations'];
    match.mode='normalized_exact';
    continue;
   }
   // The canonical read producer must be dedicated to this match, so no
   // unrelated selected read/outcome is silently redirected.
   if(steps.some(x=>x.id!==match.id&&x.id!==producer.id&&
     (x.source?.step===producer.id||
      x.deps?.includes(producer.id)||
      JSON.stringify(x.args||{}).includes('"step":'+producer.id))))continue;
   if(doc.output?.step===producer.id||
      (doc.checks||[]).some(x=>x.step===producer.id))continue;
   const lookup=selectKnownLookup(send.capabilityId,allowed,{
    field:'name',arrayKey:'conversations',nativeOnly:true});
   if(!lookup)return null;
   producer.capabilityId=lookup.id;
   producer.args=lookup.tier===0?
     {...lookup.args,query:match.query}:{...lookup.args};
   match.source.path=['conversations'];
   match.mode='normalized_exact';
   rules.push('VERIFIED_NATIVE_RECIPIENT_SOURCE_REBIND');
  }
 }
 return rules;
}
export function canonicalizeReadIdentitySources(raw,allowed,{
 identityArgumentFields=()=>[],ownerGoal=null
}={}){
 const unchanged={raw,changed:false,rule:null};
 if(typeof raw!=='string'||!Array.isArray(allowed)||allowed.length>300)
  return unchanged;
 let parsed;
 try{parsed=JSON.parse(raw)}catch{return unchanged}
 if(!object(parsed)||parsed.schema!=='dexa.tool-plan.v3'||parsed.status||
  !Array.isArray(parsed.steps)||parsed.steps.length<1||
  parsed.steps.length>18||!object(parsed.output)||!object(parsed.answer))
  return unchanged;
 if(parsed.steps.some((s,i)=>!object(s)||s.id!==i+1||
  !['TOOL','TRANSFORM'].includes(s.kind)||
  (s.kind==='TOOL'&&!catalogRoute(s.capabilityId))))
  return unchanged;
 // Atomic admission: if any literal identity cannot be grounded via an
 // explicitly selected exact provider lookup, reject the entire rewrite.
 const doc=structuredClone(parsed);
 const rules=rebindCanonicalNativeWrite(doc,allowed,ownerGoal);
 if(rules===null)return unchanged;
 const pending=[];
 for(const step of doc.steps){
  if(step.kind!=='TOOL')continue;
  for(const field of identityArgumentFields(step.capabilityId)){
   const label=step.args?.[field];
   if(typeof label!=='string')continue;
   if(!safeLabel(label))return unchanged;
   const route=catalogRoute(step.capabilityId);
   let req=null;
   if(field==='conversation'&&route?.isReadOnly===true&&
      !route.requiresElevation&&step.mode===undefined)
    req={kind:'read',field,label,consumerId:step.id,
     fieldName:'handle',arrayKey:null,matchMode:'safe_unique'};
   else req=resolveNativeWriteDescriptor(step,field,label,ownerGoal);
   if(!req)return unchanged;
   pending.push(req);
  }
 }
 if(pending.length>2||
  pending.filter(x=>x.kind==='read').length>1||
  pending.filter(x=>x.kind==='native_write').length>1)
  return unchanged;
 if(pending.length===0){
  if(rules.length===0)return unchanged;
  const text=JSON.stringify(doc);
  return text.length<=35000?{raw:text,changed:true,rule:rules.join('+')}:unchanged;
 }
 // Resolve from left to right, and re-evaluate later IDs after each
 // insertion. No provider operation runs until the resulting typed plan
 // passes all original Rana schema, dependency and identity guards.
 for(let i=0;i<pending.length;i++){
  const req=pending[i],consumer=doc.steps.find(s=>s.id===
   req.consumerId+(doc.steps.length-parsed.steps.length));
  // Always re-find by original selector; original old ID may have shifted
  // only by insertions BEFORE it. Kept in a dedicated mutable ID list.
  if(!consumer||consumer.kind!=='TOOL'||consumer.args?.[req.field]!==req.label)
   return unchanged;
  const current={...req,consumerId:consumer.id};
  if(current.kind==='native_write'){
   const matchId=existingExactNativeMatch(doc,current);
   if(matchId!==null){
    if(!bindMatch(doc,current,matchId))return unchanged;
    rules.push('VERIFIED_NATIVE_DESTINATION_EXISTING_MATCH');
    continue;
   }
  }
  const lookup=selectKnownLookup(consumer.capabilityId,allowed,{
   field:current.fieldName,arrayKey:current.arrayKey,
   nativeOnly:current.kind==='native_write'});
  if(!lookup||!insertObservedMatch(doc,current,lookup))return unchanged;
  rules.push(current.kind==='read'?
   'VERIFIED_READ_IDENTITY_DEPENDENCY_CLOSURE':
   'VERIFIED_NATIVE_DESTINATION_DEPENDENCY_CLOSURE');
 }
 const text=JSON.stringify(doc);
 if(text.length>35000||doc.steps.length>18)return unchanged;
 return {raw:text,changed:true,rule:rules.join('+')};
}
