// Generic strict post-model admission for ALL catalog tool plans.
// Capability metadata (not the source provider or owner wording) determines
// whether an argument must come from a proven provider-returned record.
import {inputSchemaFor,catalogRoute,catalogList} from './dexa_catalog_registry.mjs';
import {uniqueEntityLabelFilter,isProviderEntitySource} from './dexa_entity_resolver_v1.mjs';
import {parseTypedPlan} from './dexa_tool_plan_v3.mjs';
import {sameWholeIdentityLabelOrthography} from './dexa_scoped_name_match.mjs';
import {canonicalizeUnauditedMessagingReadPaths}
 from './dexa_messaging_plan_canonicalizer_v1.mjs';
import {canonicalizeReadIdentitySources}
 from './dexa_provider_identity_closure_v1.mjs';
import {canonicalizeVerifiedTypedPaths,describeInvalidTypedPath}
 from './dexa_typed_path_canonicalizer_v1.mjs';
import {assertKnownTypedDataflowFields,canonicalizeProviderSemanticPredicates,
 catalogKnownOutputShape}
 from './dexa_catalog_output_adapters_v1.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code})};
const safeObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const VALID_KINDS=new Set(['text','messages','conversations','count','sender_role','group_message','json']);
const UNGROUNDED_IDENTITY='GENERAL_PLAN_IDENTITY_NOT_PROVIDER_GROUNDED';
// A provider-selected RECENT record is not a name-matched recipient.
// Only a read operation may consume a real handle chosen by an audited,
// strictly ordered recency selector. This proves the selection within the
// observed bounded set, NEVER full-account coverage or a write recipient.
function verifiedObservedRecencySelection({consumer,field,origin,identityChain}){
 if(consumer?.isReadOnly!==true||field!=='conversation'||
    origin?.kind!=='TOOL'||identityChain?.length!==3)return false;
 const observed=catalogKnownOutputShape(origin.capabilityId);
 const recency=observed?.recency;
 if(!recency||recency.globalCoverageGuaranteed!==false||
    recency.scope!=='RECENT_VISIBLE_BOUNDED'||
    !Number.isSafeInteger(recency.maxItems)||
    origin.args?.limit!==recency.maxItems)return false;
 const [only,take,sort]=identityChain;
 if(only.op!=='ONLY'||take.op!=='TAKE'||sort.op!=='SORT'||
    take.count!==1||sort.direction!=='desc'|| 
    JSON.stringify(sort.path)!==JSON.stringify([recency.field])||
    JSON.stringify(only.source?.path)!=='[]'||
    JSON.stringify(take.source?.path)!=='[]'||
    sort.source?.step!==origin.id||
    JSON.stringify(sort.source?.path)!=='["conversations"]')return false;
 const source=observed.arrays?.conversations;
 return source?.fieldTypes?.[recency.field]==='integer'&&
    source.fields?.includes('handle')&&
    source.fieldTypes?.handle==='string';
}
function verifiedBoundedIdentityRecencyProbe(step,typed,prop){
 if(step?.kind!=='TOOL'||step.mode!=='EACH'||prop!=='conversation'||
    catalogRoute(step.capabilityId)?.isReadOnly!==true||
    JSON.stringify(step.args?.conversation)!=='{"$item":{"path":["handle"]}}'||
    step.args?.limit!==1||step.maxItems>50||
    Object.keys(step.args).sort().join(',')!=='conversation,limit')return false;
 const recency=catalogKnownOutputShape(step.capabilityId)?.recency;
 if(recency?.kind!=='LATEST_MESSAGE_PER_OBSERVED_CONVERSATION'||
    recency.ordering!=='newest_first'||recency.messageLimit!==1||
    recency.fullPopulationGuaranteed!==false||
    !(recency.field==='date'&&recency.unit==='unix_seconds'||
      recency.field==='timestamp_ms'&&recency.unit==='unix_milliseconds')||
    !Number.isSafeInteger(recency.maxCandidates)||
    step.maxItems>recency.maxCandidates)return false;
 const selected=typed.steps.find(x=>x.id===step.source?.step);
 if(selected?.op!=='FILTER'||
    JSON.stringify(step.source?.path)!=='[]'||
    selected.predicate?.op!=='normalized_equal'||
    JSON.stringify(selected.predicate?.path)!=='["name"]'||
    typeof selected.predicate?.value!=='string')return false;
 const source=typed.steps.find(x=>x.id===selected.source?.step);
 if(source?.kind!=='TOOL'||!isProviderEntitySource(source.capabilityId)||
    JSON.stringify(selected.source?.path)!=='["conversations"]'||
    typeof source.args?.query!=='string'||
    !sameWholeIdentityLabelOrthography(source.args.query,
      selected.predicate.value))return false;
 const q=selected.predicate.value;
 const selections=typed.steps.filter(x=>x.kind==='TRANSFORM'&&
   x.op==='RECENT_MATCH'&&x.source?.step===step.id&&
   sameWholeIdentityLabelOrthography(x.query,q));
 if(selections.length!==1)return false;
 const ns=id=>catalogRoute(id)?.cfName?.split('_')[0]||null;
 return ns(source.capabilityId)===ns(step.capabilityId);
}
// A model-requested "newer" tie-breaker is not permission to take the first
// search candidate. Only a same-provider, bounded read-only EACH over the
// COMPLETE observed candidate array may establish a strict newest winner.
// The provider metadata declares the timestamp field and newest-first order.
// This is a general capability contract, not a language/name/provider hack.
function verifiedAuditedRecentMatchSelection({consumer,field,typed,
  origin,identityChain,handlePath}){
 if(consumer?.isReadOnly!==true||field!=='conversation'||
    origin?.kind!=='TOOL'||origin.mode!=='EACH'||
    identityChain?.length!==1||identityChain[0].op!=='RECENT_MATCH'||
    JSON.stringify(handlePath)!=='["handle"]')return false;
 const match=identityChain[0],recency=catalogKnownOutputShape(origin.capabilityId)?.recency;
 if(!recency||recency.kind!=='LATEST_MESSAGE_PER_OBSERVED_CONVERSATION'||
    recency.source!=='VERIFIED_PROVIDER_MESSAGE_LIST_NEWEST_FIRST'||
    recency.ordering!=='newest_first'||
    recency.fullPopulationGuaranteed!==false||
    recency.messageLimit!==1||
    !(recency.field==='date'&&recency.unit==='unix_seconds'||
      recency.field==='timestamp_ms'&&recency.unit==='unix_milliseconds')||
    !Number.isSafeInteger(recency.maxCandidates)||
    !catalogKnownOutputShape(origin.capabilityId)?.arrays?.messages?.fields
      ?.includes(recency.field)||
    origin.maxItems>recency.maxCandidates||
    origin.args?.limit!==1||
    JSON.stringify(origin.args?.conversation)!=='{"$item":{"path":["handle"]}}'||
    Object.keys(origin.args).sort().join(',')!=='conversation,limit'||
    match.source?.step!==origin.id||
    JSON.stringify(match.source?.path)!=='[]'||
    JSON.stringify(match.recencyPath)!==
     JSON.stringify(['response','messages',0,recency.field])||
    !Array.isArray(match.fields)||match.fields.length!==1||
    !Array.isArray(match.fields[0])||match.fields[0].length!==2||
    match.fields[0][0]!=='source'||
    !['name','display_name','full_name','title'].includes(match.fields[0][1]))
  return false;
 const selectionSource=typed.steps.find(x=>x.id===origin.source?.step);
 // A provider TOOL output is a response envelope, not an array typed by the
 // parser. Explicit FILTER is mandatory before bounded EACH and narrows only
 // by the SAME full name (no TAKE, INDEX, opaque aliases or loss of peers).
 if(selectionSource?.kind!=='TRANSFORM'||
    selectionSource.op!=='FILTER'||
    JSON.stringify(origin.source?.path)!=='[]'||
    !['normalized_equal','equal'].includes(selectionSource.predicate?.op)||
    JSON.stringify(selectionSource.predicate?.path)!=='["name"]'||
    !sameWholeIdentityLabelOrthography(selectionSource.predicate.value,match.query))
  return false;
 const source=typed.steps.find(x=>x.id===selectionSource.source?.step);
 if(source?.kind!=='TOOL'||!isProviderEntitySource(source.capabilityId)||
    !Array.isArray(selectionSource.source?.path)||
    selectionSource.source.path.length!==1)
  return false;
 const collection=selectionSource.source.path[0];
 if(!['conversations','contacts'].includes(collection)||
    !['conversation_search','conversation_list','contact_search','contact_list']
      .some(suffix=>catalogRoute(source.capabilityId)?.cfName?.endsWith('_'+suffix)))
  return false;
 if(typeof source.args?.query==='string'&&
    !sameWholeIdentityLabelOrthography(source.args.query,match.query))
  return false;
 const names=x=>catalogRoute(x.capabilityId)?.cfName?.split('_')[0]||null;
 return names(source)===names(origin)&&
   names(source)===catalogRoute(consumer?.capabilityId)?.cfName?.split('_')[0]||
   false;
}
export const GENERAL_CONTRACT_CODES=Object.freeze({
 UNGROUNDED_IDENTITY,
 ANSWER_MISSING:'GENERAL_PLAN_ANSWER_CONTRACT_MISSING',
 ANSWER_INVALID:'GENERAL_PLAN_ANSWER_CONTRACT_INVALID',
 OUTPUT_FORMAT:'GENERAL_PLAN_OUTPUT_CONTRACT_INVALID',
 TARGET_PROVENANCE:'GENERAL_PLAN_TARGET_PROVENANCE_UNVERIFIED'
});
export function providerIdentityArgumentFields(capabilityId){
 const schema=inputSchemaFor(capabilityId);
 if(!safeObject(schema?.properties))return [];
 // Cross-provider semantic property: a "conversation" field in tool input
 // is a provider identity, not free text to infer from natural language.
 // This metadata rule applies to every provider exposing that field.
 const route=catalogRoute(capabilityId);
 const native=route?.cfName||'';
 const namespace=native.split('_')[0];
 // Scope identity fields only to providers which actually expose bound
 // contact/conversation lookup cards. CAD/other 'target' input stays intact.
 const hasIdentitySource=!!namespace&&catalogList().some(card=>{
  const candidate=catalogRoute(card.id);
  return candidate?.isReadOnly===true&&
   candidate.requiresElevation!==true&&
   candidate.cfName?.startsWith(namespace+'_')&&
   /_(?:contact|conversation)_(?:search|list)$/.test(candidate.cfName);
 });
 if(!hasIdentitySource)return [];
 const keys=['conversation','target','recipient'];
 // A phone SMS read with a named person's address is also an entity query.
 // The provider's optional address filter has the same provenance contract
 // as an SMS send recipient; no unverified name is sent to its native API.
 if(/_sms_list$/.test(native)&&schema.properties.address?.type==='string')
  keys.push('address');
 return keys.filter(key=>Object.hasOwn(schema.properties,key));
}
export function canonicalizeGenericPlanOutput(raw){
 if(typeof raw!=='string'||raw.length>35000||raw.length<2)
  fail('GENERAL_PLAN_RESPONSE_INVALID');
 let plan;
 try{plan=JSON.parse(raw)}catch{return Object.freeze({raw,changed:false})}
 if(!safeObject(plan)||plan.schema!=='dexa.tool-plan.v3'||
    plan.status||!safeObject(plan.output)||!safeObject(plan.output.answer))
  return Object.freeze({raw,changed:false});
 const answer=plan.output.answer;
 if(plan.answer!==undefined||Object.keys(answer).length!==1||
    !VALID_KINDS.has(answer.kind)||
    Object.keys(plan.output).sort().join(',')!=='answer,format,path,step')
  fail('GENERAL_PLAN_ANSWER_CONTRACT_INVALID');
 const normalized=structuredClone(plan);
 normalized.answer=normalized.output.answer;
 delete normalized.output.answer;
 return Object.freeze({raw:JSON.stringify(normalized),changed:true,
  rule:'NESTED_ANSWER_TO_TOP_LEVEL'});
}
function canonicalizeBilingualIdentityMatches(raw){
 let p;
 try{p=JSON.parse(raw)}catch{return {raw,changed:false}}
 if(!p||!Array.isArray(p.steps))return {raw,changed:false};
 const byId=new Map(p.steps.map(s=>[s.id,s]));
 let changed=false;
 for(const step of p.steps){
  if(step.kind!=='TRANSFORM'||step.op!=='MATCH'||
     step.mode!=='normalized_exact')continue;
  let source=byId.get(step.source?.step);
  const seen=new Set();
  while(source?.kind==='TRANSFORM'&&!seen.has(source.id)){
   seen.add(source.id);source=byId.get(source.source?.step);
  }
  if(source?.kind==='TOOL'&&
     isProviderEntitySource(source.capabilityId)){
   // EXACT user-name semantics remain whole-label only. Script difference
   // must never make an exact identity fail merely due to Qwen's choice of
   // a list (or unread subset) instead of a search route.
   step.mode='bilingual_exact';changed=true;
  }
 }
 return {raw:changed?JSON.stringify(p):raw,changed,
  rule:changed?'BILINGUAL_PROVIDER_IDENTITY_MATCH':null};
}
// A verified empty collection is still data. A generated "non_empty"
// postcondition must not turn an authenticated zero-unread result into an
// execution failure. This applies via the SAME typed conversation family on
// every messenger; unrelated existence requirements remain untouched.
export function canonicalizeEmptyUnreadPostconditions(raw){
 let plan;
 try{plan=JSON.parse(raw)}catch{return {raw,changed:false,rule:null}}
 if(!safeObject(plan)||plan.schema!=='dexa.tool-plan.v3'||
    !Array.isArray(plan.steps)||!Array.isArray(plan.checks)||
    !safeObject(plan.output)||!Array.isArray(plan.output.path)||
    plan.output.path.length!==1||plan.answer?.kind!=='conversations')
  return {raw,changed:false,rule:null};
 const producer=plan.steps.find(x=>x.id===plan.output.step);
 if(producer?.kind!=='TOOL'||producer.mode!==undefined)
  return {raw,changed:false,rule:null};
 const route=catalogRoute(producer.capabilityId);
 const family=catalogKnownOutputShape(producer.capabilityId)
  ?.arrays?.[plan.output.path[0]]?.family;
 if(route?.isReadOnly!==true||
    !String(route.cfName||'').endsWith('_unread_list')||
    family!=='conversations')
  return {raw,changed:false,rule:null};
 let changed=false;
 for(const check of plan.checks){
  if(check?.step===plan.output.step&&
     JSON.stringify(check.path)===JSON.stringify(plan.output.path)&&
     check.op==='non_empty'){
   check.op='exists';changed=true;
  }
 }
 return {raw:changed?JSON.stringify(plan):raw,changed,
  rule:changed?'VERIFIED_EMPTY_UNREAD_COLLECTION_IS_VALID':null};
}

// The native WeChat messages list is already ordered by observed screen
// position, top-to-bottom. Its per-row "time" is null/unverified. Therefore a
// generated descending SORT by "time" is semantically a REVERSE of the native
// sequence, not an ordinary timestamp sort. Keep this correction to the
// audited direct WeChat messages source, never other providers or arrays.
export function canonicalizeNativeVisibleMessageChronology(raw){
 let plan;
 try{plan=JSON.parse(raw)}catch{return {raw,changed:false,rule:null}}
 if(!safeObject(plan)||plan.schema!=='dexa.tool-plan.v3'||
    !Array.isArray(plan.steps))return {raw,changed:false,rule:null};
 const byId=new Map(plan.steps.map(s=>[s.id,s]));
 let changed=false;
 for(const step of plan.steps){
  if(step?.kind!=='TRANSFORM'||step.op!=='SORT'||
     step.direction!=='desc'||JSON.stringify(step.path)!=='["time"]'||
     JSON.stringify(step.source?.path)!=='["messages"]')continue;
  const producer=byId.get(step.source.step);
  if(producer?.kind!=='TOOL'||producer.mode!==undefined||
     catalogRoute(producer.capabilityId)?.cfName!=='wechat_message_list')
   continue;
  const observed=catalogKnownOutputShape(producer.capabilityId)
    ?.arrays?.messages;
  if(observed?.ordering!=='ACCESSIBILITY_VISIBLE_TOP_TO_BOTTOM'||
     observed?.fields?.includes('time')!==true||
     observed?.optionalFields?.includes('time')!==true||
     observed?.latestEdgeGuaranteed!==false)continue;
  step.op='REVERSE';
  delete step.path;
  delete step.direction;
  changed=true;
 }
 return {raw:changed?JSON.stringify(plan):raw,changed,
  rule:changed?'NATIVE_VISIBLE_MESSAGE_CHRONOLOGY_REBIND':null};
}

// The model specifies *which* verified projection it wants, not redundant
// boilerplate proving that a selected output exists. Rana generates that
// universal mechanical assertion from the exact selected typed dataflow.
// No extra model call, no guessed identity, no changed output meaning.
export function compileMandatoryOutputEvidence(raw){
 if(typeof raw!=='string')fail('GENERAL_PLAN_JSON_INVALID');
 let p;
 try{p=JSON.parse(raw)}catch{return {raw,changed:false,rule:null}}
 if(!safeObject(p)||p.schema!=='dexa.tool-plan.v3'||
    !Array.isArray(p.steps)||!safeObject(p.output)||
    !Number.isSafeInteger(p.output.step)||!Array.isArray(p.output.path)||
    !safeObject(p.answer))
  return {raw,changed:false,rule:null};
 if(p.checks!==undefined&&!Array.isArray(p.checks))
  return {raw,changed:false,rule:null};
 const checks=Array.isArray(p.checks)?p.checks:[];
 if(checks.some(c=>c?.step===p.output.step&&
    JSON.stringify(c.path)===JSON.stringify(p.output.path)))
  return {raw,changed:false,rule:null};
 // The parser still validates all actual paths, dependencies, checks, tools,
 // answer kind and any model-authored extra conditions before any effects.
 if(checks.length>=32)return {raw,changed:false,rule:null};
 const next=structuredClone(p);
 next.checks=[...checks,{step:next.output.step,
   path:[...next.output.path],op:'exists'}];
 return {raw:JSON.stringify(next),changed:true,
  rule:'MECHANICALLY_PROVEN_FINAL_OUTPUT_CHECK'};
}
export function validateGenericPlanContract(raw,allowed,{ownerGoal=null}={}){
 const canon=canonicalizeGenericPlanOutput(raw);
 const messaging=canonicalizeUnauditedMessagingReadPaths(canon.raw);
 const paths=canonicalizeVerifiedTypedPaths(messaging.raw);
 const emptyUnread=canonicalizeEmptyUnreadPostconditions(paths.raw);
 // A model-supplied display label is not a provider handle. For a single
 // read-only conversation selector, the ORIGINAL authorized Kata shortlist
 // may provide a documented same-provider lookup + strict unique MATCH.
 // The existing provider identity validator still gates every real dispatch.
 const identity=canonicalizeReadIdentitySources(emptyUnread.raw,allowed,{
  identityArgumentFields:providerIdentityArgumentFields,ownerGoal});
 const semantic=canonicalizeProviderSemanticPredicates(identity.raw);
 const bilingual=canonicalizeBilingualIdentityMatches(semantic.raw);
 const chronology=canonicalizeNativeVisibleMessageChronology(bilingual.raw);
 const complete=compileMandatoryOutputEvidence(chronology.raw);
 const validatedRaw=complete.raw;
 const normalizations={
  raw:validatedRaw,
  changed:canon.changed||messaging.changed||paths.changed||emptyUnread.changed||identity.changed||
   semantic.changed||bilingual.changed||chronology.changed||complete.changed,
  rule:[canon.rule,messaging.rule,paths.rule,emptyUnread.rule,identity.rule,semantic.rule,
   bilingual.rule,chronology.rule,complete.rule]
   .filter(Boolean).join("+")||null
 };
 let typed;
 try{typed=parseTypedPlan(validatedRaw,allowed)}
 catch(error){
  if(['TOOL_PLAN_PATH_INVALID','TOOL_PLAN_PATH_UNSAFE'].includes(error?.code)){
   const diagnostic=describeInvalidTypedPath(validatedRaw,error.code);
   // No raw recipe, field values, group names or model output in logs.
   process.stderr.write('DEXA_TYPED_PATH_REJECTED '+
    JSON.stringify(diagnostic)+'\n');
  }
  throw error;
 }
 if(typed.status)return Object.freeze({...normalizations,typed});
 assertKnownTypedDataflowFields(typed);
 let parsed;
 try{parsed=JSON.parse(validatedRaw)}catch{fail('GENERAL_PLAN_JSON_INVALID')}
 if(!safeObject(parsed.answer)||!VALID_KINDS.has(parsed.answer.kind)||
    Object.keys(parsed.answer).length!==1)
  fail(GENERAL_CONTRACT_CODES.ANSWER_MISSING);
 for(const step of typed.steps){
  if(step.kind==='TRANSFORM'&&step.op==='MATCH'){
   const producer=typed.steps.find(x=>x.id===step.source?.step);
   // Search and unique MATCH must refer to the SAME complete identity label.
   // Accept ONLY mechanical Persian/Arabic orthography and separator
   // equivalence already admitted by the exact scoped-name matcher.
   // Materially different names, partial labels, typos, cross-script guesses
   // and semantic aliases remain contradictions, before any provider read.
   if(producer?.kind==='TOOL'&&
      typeof producer.args?.query==='string'&&
      typeof step.query==='string'&&
      !sameWholeIdentityLabelOrthography(producer.args.query,step.query))
    fail('GENERAL_PLAN_SEARCH_MATCH_QUERY_CONTRADICTION');
  }
  if(step.kind!=='TOOL')continue;
  // Provider input contracts are metadata from the catalog, not rules
  // hardcoded for Telegram/WhatsApp/GitHub or any owner phrase.
  const native=inputSchemaFor(step.capabilityId);
  for(const field of native?.required||[]){
   const actual=step.args?.[field];
   if(!Object.hasOwn(step.args||{},field)||actual===null||
      actual===undefined||typeof actual==='string'&&!actual.trim())
    fail('GENERAL_PLAN_REQUIRED_PROVIDER_ARGUMENT_MISSING');
  }
  // Native selector requirements are provider-audited metadata, not
  // task-phrase inference. A bare 'latest_message' flag alone is not a
  // provider-wide latest-message capability.
  const selector=catalogKnownOutputShape(step.capabilityId)?.selectorContract;
  if(step.args?.latest_message===true&&
     selector?.latest_message?.requiresObservedConversation===true&&
     step.args?.conversation===undefined)
   fail('GENERAL_PLAN_REQUIRED_PROVIDER_ARGUMENT_MISSING');
  for(const prop of providerIdentityArgumentFields(step.capabilityId)){
   const v=step.args?.[prop];
   if(v===undefined)continue;
   if(step.mode==='EACH'){
    // $item is permitted ONLY when every bounded provider-owned candidate
    // handle is read without mutation for a subsequent verified recency
    // comparison. The normal $ref requirement remains mandatory otherwise.
    if(!verifiedBoundedIdentityRecencyProbe(step,typed,prop))
     fail('GENERAL_PLAN_EACH_ENTITY_NOT_PROVIDER_GROUNDED');
    continue;
   }
   // A recognized provider identity must be a link to a verified earlier
   // TOOL/TRANSFORM output in the SAME plan. No hardcoded source/user aliases.
   if(!safeObject(v)||!safeObject(v.$ref)||
      !Number.isInteger(v.$ref.step)||!Array.isArray(v.$ref.path))
    fail(UNGROUNDED_IDENTITY);
   const producing=typed.steps.find(x=>x.id===v.$ref.step);
   if(!producing||producing.kind==='USER_GATE')
    fail(UNGROUNDED_IDENTITY);
   // Provider identity is provenance, not a literal string; a handle
   // observed through provider A cannot authorize a read from provider B.
   let origin=producing;
   const identityChain=[],visited=new Set();
   while(origin?.kind==='TRANSFORM'&&!visited.has(origin.id)){
    visited.add(origin.id);
    identityChain.push(origin);
    origin=typed.steps.find(x=>x.id===origin.source?.step);
   }
   // A canonical CONVERSATION is a read-only observation, not a
   // write-authorized destination. A native provider lookup remains the
   // separate source of any send/mutation recipient authority.
   const readOnlyConsumer=catalogRoute(step.capabilityId)?.isReadOnly===true;
   if(!readOnlyConsumer&&identityChain.some(x=>
      x.source?.path?.[0]==='canonical_conversations'))
    fail('GENERAL_PLAN_CANONICAL_IDENTITY_WRITE_FORBIDDEN');
   const truncatesCandidates=identityChain.some(x=>
    ['TAKE','UNIQUE'].includes(x.op));
   const uniqueRecordProven=!truncatesCandidates&&(
    identityChain.some(x=>x.op==='MATCH')||
    (identityChain.some(x=>x.op==='ONLY')&&
     identityChain.some(x=>x.op==='FILTER'&&
      uniqueEntityLabelFilter(typed.steps,x))));
   // A name-search or contact-list contains CANDIDATES, never a recipient.
   // An array index or model-chosen first record cannot authenticate a
   // personal chat, phone recipient or named contact. MATCH/ONLY proves a
   // unique observed provider record without another semantic model.
   const entitySource=isProviderEntitySource(origin?.capabilityId);
   const observedRecency=entitySource&&
    verifiedObservedRecencySelection({
     consumer:catalogRoute(step.capabilityId),field:prop,
     origin,identityChain});
   const observedRecentMatch=verifiedAuditedRecentMatchSelection({
    consumer:{...catalogRoute(step.capabilityId),
     capabilityId:step.capabilityId},field:prop,typed,origin,
    identityChain,handlePath:v.$ref.path});
   if((entitySource&&!uniqueRecordProven&&!observedRecency)||
      (origin?.mode==='EACH'&&!observedRecentMatch))
    fail('GENERAL_PLAN_ENTITY_SELECTION_NOT_UNIQUE');
   // A resolved display label is not itself an authenticated destination.
   // Only an observed provider-owned handle/phone/id may authorize a
   // recipient. Provider lookup matching the NAME but returning the NAME
   // again is not an identity resolution proof.
   // Distinguish provider-native *recipient selectors* from opaque handles
   // using the independently audited tool output/recipient contract. A
   // provider that promises native exact-name uniqueness may take the
   // EXACT observed name after a uniquely verified provider MATCH.
   // This never allows arbitrary model strings, canonical read-only
   // conversation aliases, fuzzy matches, first-row picks, or cross-provider
   // recipients. The native send must independently recheck uniqueness.
   const inputContract=catalogKnownOutputShape(step.capabilityId)
     ?.identityInputs?.[prop];
   const sourceShape=catalogKnownOutputShape(origin?.capabilityId);
   const matched=identityChain.length===1&&
     identityChain[0].op==='MATCH'?identityChain[0]:null;
   const nativeNameSelector=inputContract?.kind==='NATIVE_UNIQUE_EXACT_LABEL'&&
     inputContract.nativeOperationVerifiesUniqueExactRecipient===true&&
     inputContract.neverTrustCanonicalIdentityForWrite===true&&
     inputSchemaFor(step.capabilityId)?.properties?.[prop]?.type==='string'&&
     v.$ref.path.length===1&&
     v.$ref.path[0]===inputContract.sourceField&&
     origin?.kind==='TOOL'&&origin.mode===undefined&&
     isProviderEntitySource(origin.capabilityId)&&
     (inputContract.sourceRecordFamily!=='conversation'||
      /_conversation_(search|list)$/.test(
       catalogRoute(origin.capabilityId)?.cfName||''))&&
     matched!==null&&
     inputContract.requiredMatchModes?.includes(matched.mode)&&
     JSON.stringify(matched.fields)===
      JSON.stringify([[inputContract.sourceField]])&&
     typeof matched.query==='string'&&matched.query.trim().length>=2&&
     JSON.stringify(matched.source?.path)===
      JSON.stringify([inputContract.sourceCollection])&&
     sourceShape?.arrays?.[inputContract.sourceCollection]
       ?.fields?.includes(inputContract.sourceField)&&
     !inputContract.sourceCollection.startsWith('canonical_');
   if((entitySource||observedRecentMatch)&&
      !['handle','id','phone','number','address']
       .includes(v.$ref.path.at(-1))&&!nativeNameSelector)
    fail('GENERAL_PLAN_IDENTITY_HANDLE_NOT_VERIFIED');
   // Destination and phone-address arguments are specifically recipient
   // operations. Matching an arbitrary message or file cannot authorize
   // a personal or group destination even within the same provider.
   if(['recipient','target','address'].includes(prop)&&!entitySource)
    fail('GENERAL_PLAN_IDENTITY_SOURCE_UNVERIFIED');
   const native=id=>catalogRoute(id)?.cfName?.split('_')[0]||null;
   const consumerNamespace=native(step.capabilityId);
   const producerNamespace=origin?.kind==='TOOL'?native(origin.capabilityId):null;
   if(!producerNamespace||!consumerNamespace||
      consumerNamespace!==producerNamespace)
    fail('GENERAL_PLAN_CROSS_PROVIDER_IDENTITY_INVALID');
  }
 }
 return Object.freeze({...normalizations,typed});
}
