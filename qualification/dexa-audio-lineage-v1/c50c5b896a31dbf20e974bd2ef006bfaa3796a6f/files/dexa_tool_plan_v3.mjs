// Universal versioned tool/data-flow plan. No natural-language string parsing.
// Every invocation has typed arguments; every data dependency has an explicit ref.
import {catalogRoute,inputSchemaFor} from "./dexa_catalog_registry.mjs";
import {DEXA_TEXT_WRITER_ID,validateWriterPlanStep} from "./dexa_text_writer_v1.mjs";
import {scopedMatchOne,validateScopedMatchSpec} from "./dexa_scoped_name_match.mjs";
import {catalogKnownOutputShape,describeTypedProjection}
 from "./dexa_catalog_output_adapters_v1.mjs";
const MAX_PLAN=35000, MAX_STEPS=18, MAX_PATH=10, MAX_ARG_JSON=18000;
const OPERATIONS=new Set(["FILTER","ONLY","TAKE","REVERSE","SORT","PICK","COUNT","MATCH","UNIQUE"]);
const COMPARISONS=new Set(["equal","normalized_equal","contains","greater","less","not_equal","in","exists"]);
const CHECKS=new Set(["exists","non_empty","equal","normalized_equal","not_equal","count_equal","count_at_least","all_equal","sorted_asc","sorted_desc"]);
const DENIED_FIELDS=new Set(["__proto__","prototype","constructor"]);
const ANSWER_KINDS=new Set(["text","messages","conversations","sender_role","count","group_message","json"]);
// These are structural constraints on the existing typed flow, not another
// language-model/semantic evaluator. TOOL output shapes remain untrusted
// unless an adapter has supplied an explicit verified schema.
function knownOutputShape(step){
 if(step?.kind==="TOOL"&&step.mode==="EACH")return "array";
 if(step.kind!=="TRANSFORM")return "unknown";
 if(["FILTER","TAKE","REVERSE","SORT","UNIQUE"].includes(step.op))return "array";
 if(["MATCH","ONLY"].includes(step.op))return "record";
 if(step.op==="COUNT")return "number";
 return "unknown";
}
function checkKnownPath(shape,path){
 if(path.length===0||shape==="unknown")return;
 if(shape==="array"&&typeof path[0]!=="number")
  bad("TOOL_PLAN_TYPE_PATH_MISMATCH");
 if(shape==="record"&&typeof path[0]!=="string")
  bad("TOOL_PLAN_TYPE_PATH_MISMATCH");
 if(shape==="number")bad("TOOL_PLAN_TYPE_PATH_MISMATCH");
}
// A verified output family is proved by the native catalog adapter schema,
// not by a hardcoded application or capability ID. The same check works for
// every messenger or data service with a documented provider result shape.
function verifiedLineageRecordFields(steps,startId,arrayFamily){
 const seen=new Set(),byId=new Map(steps.map(step=>[step.id,step]));
 const visit=id=>{
  if(seen.has(id))return null;seen.add(id);
  const step=byId.get(id);
  if(!step)return null;
  if(step.kind==="TOOL"){
   const fields=catalogKnownOutputShape(step.capabilityId)
    ?.arrays?.[arrayFamily]?.fields;
   return Array.isArray(fields)&&fields.length?[...fields]:null;
  }
  if(step.kind!=="TRANSFORM")return null;
  return visit(step.source.step);
 };
 return visit(startId);
}
function validateAnswerContract(answer,plan,steps){
 if(answer===undefined)return null; // legacy read-only fixtures remain loadable.
 ownKeys(answer,["kind"],"TOOL_ANSWER_FIELDS_INVALID");
 if(!ANSWER_KINDS.has(answer.kind))bad("TOOL_ANSWER_KIND_INVALID");
 const origin=steps.find(step=>step.id===plan.output.step);
 const shape=answer.kind==="sender_role"?"unknown":
  describeTypedProjection(steps,plan.output.step,plan.output.path).kind;
 if(!plan.checks.some(check=>
   check.step===plan.output.step &&
   plan.output.path.every((part,index)=>check.path[index]===part)))
  bad("TOOL_ANSWER_OUTPUT_NOT_POSTCONDITION_VERIFIED");
 if(answer.kind==="messages"&&!verifiedLineageRecordFields(
   steps,plan.output.step,"messages"))
  bad("TOOL_ANSWER_MESSAGES_ORIGIN_INVALID");
 if(answer.kind==="conversations"&&!verifiedLineageRecordFields(
   steps,plan.output.step,"conversations"))
  bad("TOOL_ANSWER_CONVERSATION_ORIGIN_INVALID");
 if(answer.kind==="group_message"){
  if(shape!=="record"||plan.output.path.length!==0||
     !verifiedLineageRecordFields(steps,plan.output.step,"messages"))
   bad("TOOL_ANSWER_GROUP_MESSAGE_ORIGIN_INVALID");
 }
 if(answer.kind==="sender_role"){
  // A role is meaningful ONLY for a provider-grounded outgoing flag,
  // not an arbitrary boolean or a model-authored label/value map.
  const grounded=origin?.kind==="TRANSFORM"&&origin.op==="PICK"&&
    JSON.stringify(origin.path)==='["outgoing"]'&&
    plan.output.path.length===0||
    plan.output.path.at(-1)==="outgoing";
  if(!grounded||!verifiedLineageRecordFields(
    steps,plan.output.step,"messages")?.includes("outgoing"))
   bad("TOOL_ANSWER_ROLE_EVIDENCE_INVALID");
 }else if(answer.kind==="count"&&shape!=="number"&&shape!=="unknown")
  bad("TOOL_ANSWER_TYPE_MISMATCH");
 else if(answer.kind==="text"&&
    ["number","boolean","array"].includes(shape))
  bad("TOOL_ANSWER_TYPE_MISMATCH");
 else if(answer.kind==="messages"&&["number"].includes(shape))
  bad("TOOL_ANSWER_TYPE_MISMATCH");
 else if(answer.kind==="conversations"&&["number"].includes(shape))
  bad("TOOL_ANSWER_TYPE_MISMATCH");
 return Object.freeze({kind:answer.kind});
}
const bad=(reason)=>{throw Object.assign(new Error(reason),{code:reason})};
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const ownKeys=(obj,allowed,code)=>{
 if(!object(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))bad(code);
};
export const TOOL_PLAN_SCHEMA="dexa.tool-plan.v3";
export function safePath(path){
 if(!Array.isArray(path)||path.length>MAX_PATH)bad("TOOL_PLAN_PATH_INVALID");
 for(const p of path){
  if(typeof p==="string"){
   if(!p||p.length>120||DENIED_FIELDS.has(p)||p.startsWith("__"))bad("TOOL_PLAN_PATH_UNSAFE");
  }else if(!Number.isSafeInteger(p)||p<0||p>10000)bad("TOOL_PLAN_PATH_INVALID");
 }
 return path;
}
export function isReference(value){
 return object(value)&&Object.keys(value).length===1&&object(value.$ref);
}
function references(x,seen=[],depth=0){
 if(depth>9)bad("TOOL_PLAN_ARGUMENTS_TOO_DEEP");
 if(object(x)&&Object.hasOwn(x,"$ref")&&!isReference(x))bad("TOOL_PLAN_REFERENCE_INVALID");
 if(isReference(x)){
  ownKeys(x.$ref,["step","path"],"TOOL_PLAN_REFERENCE_INVALID");
  if(!Number.isSafeInteger(x.$ref.step)||x.$ref.step<1)bad("TOOL_PLAN_REFERENCE_INVALID");
  safePath(x.$ref.path);
  seen.push(x.$ref.step);
  return seen;
 }
 if(Array.isArray(x)){
  if(x.length>200)bad("TOOL_PLAN_ARGUMENT_ARRAY_TOO_LARGE");
  for(const v of x)references(v,seen,depth+1);
 }else if(object(x)){
  if(Object.keys(x).length>100)bad("TOOL_PLAN_ARGUMENT_OBJECT_TOO_LARGE");
  for(const [key,v] of Object.entries(x)){
   if(!key||key.length>120||DENIED_FIELDS.has(key)||key.startsWith("__"))
    bad("TOOL_PLAN_ARGUMENT_KEY_UNSAFE");
   references(v,seen,depth+1);
  }
 }else if(x!==null&&typeof x!=="string"&&typeof x!=="boolean"&&
          !(typeof x==="number"&&Number.isFinite(x)))bad("TOOL_PLAN_VALUE_INVALID");
 if(typeof x==="string"&&x.length>5000)bad("TOOL_PLAN_VALUE_TOO_LARGE");
 return seen;
}
function inputSchemaNode(card,selected){
 if(!selected.has(card.capabilityId))bad("TOOL_PLAN_CAPABILITY_NOT_SELECTED");
 const route=catalogRoute(card.capabilityId);
 if(!route)bad("TOOL_PLAN_CAPABILITY_UNKNOWN");
 if(!route.cfName)return {kind:"TOOL",route:"EXTERNAL_NOT_BOUND"};
 if(!inputSchemaFor(card.capabilityId))bad("TOOL_PLAN_SCHEMA_MISSING");
 return {kind:"TOOL",route:"CF",readOnly:route.isReadOnly,sensitive:route.requiresElevation,
  physicalTool:route.cfName};
}
// An EACH read maps a bounded array of already observed provider records
// to an already selected catalog operation. $item is NOT a model-provided
// handle: it resolves one field from the current observed record at runtime.
function validateEachArgs(args){
 let count=0;
 const walk=(value,depth=0)=>{
  if(depth>8)bad("TOOL_PLAN_EACH_ARGS_TOO_DEEP");
  if(object(value)&&Object.hasOwn(value,"$ref"))
   bad("TOOL_PLAN_EACH_REF_FORBIDDEN");
  if(object(value)&&Object.hasOwn(value,"$item")){
   ownKeys(value,["$item"],"TOOL_PLAN_EACH_ITEM_REF_INVALID");
   ownKeys(value.$item,["path"],"TOOL_PLAN_EACH_ITEM_REF_INVALID");
   safePath(value.$item.path);
   if(!value.$item.path.length)bad("TOOL_PLAN_EACH_ITEM_PATH_REQUIRED");
   count++;return;
  }
  if(Array.isArray(value))for(const item of value)walk(item,depth+1);
  else if(object(value))for(const item of Object.values(value))walk(item,depth+1);
 };
 walk(args);
 if(count!==1)bad("TOOL_PLAN_EACH_SINGLE_GROUNDED_ITEM_REQUIRED");
}
function validatePredicate(p){
 ownKeys(p,["path","op","value"],"TOOL_PLAN_PREDICATE_INVALID");
 safePath(p.path);
 if(!COMPARISONS.has(p.op))bad("TOOL_PLAN_PREDICATE_OPERATOR_INVALID");
 if(p.op==="exists"){
  if(Object.hasOwn(p,"value"))bad("TOOL_PLAN_PREDICATE_VALUE_UNEXPECTED");
  return;
 }
 if(p.op==="in"){
  if(!Array.isArray(p.value)||p.value.length<1||p.value.length>12||
     new Set(p.value.map(x=>JSON.stringify(x))).size!==p.value.length||
     p.value.some(x=>typeof x!=="string"||x.length>100||!x))
   bad("TOOL_PLAN_PREDICATE_MEMBERSHIP_INVALID");
  return;
 }
 if(["equal","normalized_equal","contains","not_equal"].includes(p.op)&&
  (p.value===undefined||(!isReference(p.value)&&(object(p.value)||Array.isArray(p.value)))))
  bad("TOOL_PLAN_PREDICATE_VALUE_INVALID");
 if(["greater","less"].includes(p.op)&&!Number.isFinite(p.value))
  bad("TOOL_PLAN_PREDICATE_VALUE_INVALID");
}
export function parseTypedPlan(raw,allowedCapabilities=[]){
 if(typeof raw!=="string"||raw.length<30||raw.length>MAX_PLAN)
  bad("TOOL_PLAN_TEXT_INVALID");
 let plan;
 try{plan=JSON.parse(raw)}catch{bad("TOOL_PLAN_JSON_INVALID")}
 if(!object(plan)||plan.schema!==TOOL_PLAN_SCHEMA)bad("TOOL_PLAN_SCHEMA_INVALID");
 if(plan.status==="NEEDS_INPUT"){
  ownKeys(plan,["schema","status","missing"],"TOOL_PLAN_QUESTION_FIELDS_INVALID");
  if(!Array.isArray(plan.missing)||plan.missing.length<1||plan.missing.length>8)
   bad("TOOL_PLAN_QUESTION_LIST_INVALID");
  for(const m of plan.missing){
   ownKeys(m,["field","question","capabilityId"],"TOOL_PLAN_QUESTION_INVALID");
   if(typeof m.field!=="string"||!/[A-Za-z0-9_]/.test(m.field)||
      m.field.length>100||typeof m.question!=="string"||
      m.question.length<5||m.question.length>400)
    bad("TOOL_PLAN_QUESTION_INVALID");
   if(m.capabilityId!==undefined&&
      (!allowedCapabilities.includes(m.capabilityId)||!catalogRoute(m.capabilityId)))
    bad("TOOL_PLAN_QUESTION_CAPABILITY_UNKNOWN");
  }
  return Object.freeze({schema:TOOL_PLAN_SCHEMA,status:"NEEDS_INPUT",missing:plan.missing});
 }
 if(plan.status==="UNRESOLVED"){
  ownKeys(plan,["schema","status","reason"],"TOOL_PLAN_UNRESOLVED_FIELDS_INVALID");
  if(typeof plan.reason!=="string"||plan.reason.length<5||plan.reason.length>500)
   bad("TOOL_PLAN_UNRESOLVED_REASON_INVALID");
  return Object.freeze({schema:TOOL_PLAN_SCHEMA,status:"UNRESOLVED",reason:plan.reason});
 }
 ownKeys(plan,["schema","steps","output","outputs","checks","answer"],"TOOL_PLAN_TOP_LEVEL_INVALID");
 if(!Array.isArray(plan.steps)||
    plan.steps.length<1||plan.steps.length>MAX_STEPS)bad("TOOL_PLAN_SHAPE_INVALID");
 const selected=new Set(allowedCapabilities);
 const seen=new Map();
 const steps=[];
 for(const entry of plan.steps){
  if(!object(entry)||!Number.isInteger(entry.id)||entry.id!==steps.length+1)
   bad("TOOL_PLAN_IDS_NOT_CONSECUTIVE");
  if(!Array.isArray(entry.deps)||entry.deps.some(n=>!Number.isInteger(n)||n<1||n>=entry.id)||
     new Set(entry.deps).size!==entry.deps.length)bad("TOOL_PLAN_DEPENDENCIES_INVALID");
  if(entry.after!==undefined&&(
    !Array.isArray(entry.after)||entry.after.length>MAX_STEPS||
    entry.after.some(n=>!Number.isInteger(n)||n<1||n>=entry.id)||
    new Set(entry.after).size!==entry.after.length||
    entry.after.some(n=>entry.deps.includes(n))))
   bad("TOOL_PLAN_ORDER_DEPENDENCIES_INVALID");
  const referenced=new Set();
  if(entry.kind==="TOOL"){
   ownKeys(entry,["id","kind","deps","after","capabilityId","args","mode","source","maxItems"],"TOOL_PLAN_TOOL_FIELDS_INVALID");
   if(entry.mode!==undefined){
    if(entry.mode!=="EACH"||entry.after!==undefined||
       !Number.isSafeInteger(entry.maxItems)||entry.maxItems<1||entry.maxItems>50)
     bad("TOOL_PLAN_EACH_BOUNDS_INVALID");
    ownKeys(entry.source,["step","path"],"TOOL_PLAN_EACH_SOURCE_INVALID");
    if(!Number.isSafeInteger(entry.source.step)||entry.source.step<1||
       entry.source.step>=entry.id)bad("TOOL_PLAN_EACH_SOURCE_INVALID");
    safePath(entry.source.path);
    referenced.add(entry.source.step);
    validateEachArgs(entry.args);
   }else if(entry.source!==undefined||entry.maxItems!==undefined)
    bad("TOOL_PLAN_EACH_FIELDS_WITHOUT_MODE");
   if(typeof entry.capabilityId!=="string"||!object(entry.args))bad("TOOL_PLAN_TOOL_ARGS_INVALID");
   if(JSON.stringify(entry.args).length>MAX_ARG_JSON)bad("TOOL_PLAN_TOOL_ARGS_TOO_LARGE");
   const route=inputSchemaNode(entry,selected);
   if(entry.mode!=="EACH")for(const dep of references(entry.args))referenced.add(dep);
   if(entry.mode==="EACH"&&(!route.readOnly||route.sensitive))
    bad("TOOL_PLAN_EACH_READONLY_ONLY");
   steps.push({...entry,...route,type:"E",action:"Typed tool call: "+entry.capabilityId});
  }else if(entry.kind==="USER_GATE"){
   ownKeys(entry,["id","kind","deps","question"],"TOOL_PLAN_USER_GATE_FIELDS_INVALID");
   if(entry.deps.length!==0||
      typeof entry.question!=="string"||entry.question.trim().length<5||
      entry.question.length>600)bad("TOOL_PLAN_USER_GATE_INVALID");
   // A typed user-gate emits {"answer": userReply}; its next model-authored
   // TOOL may explicitly reference {"$ref":{"step":N,"path":["answer"]}}.
   steps.push({...entry,type:"E",capabilityId:"USER",
    action:"Wait for explicit owner answer"});
  }else if(entry.kind==="TRANSFORM"){
   ownKeys(entry,["id","kind","deps","after","op","source","predicate","count","path","direction","query","fields","mode"],
    "TOOL_PLAN_TRANSFORM_FIELDS_INVALID");
   if(!OPERATIONS.has(entry.op))bad("TOOL_PLAN_TRANSFORM_UNKNOWN");
   ownKeys(entry.source,["step","path"],"TOOL_PLAN_SOURCE_INVALID");
   if(!Number.isInteger(entry.source.step)||entry.source.step>=entry.id||
      entry.source.step<1)bad("TOOL_PLAN_SOURCE_INVALID");
   safePath(entry.source.path);
   referenced.add(entry.source.step);
   if(entry.op==="FILTER"){
    validatePredicate(entry.predicate);
    // Compare to a grounded value from a prior MATCH (or other real step),
    // not a guessed sender/name string. Every such ref is a data dependency.
    if(Object.hasOwn(entry.predicate,"value"))
     for(const dep of references(entry.predicate.value))referenced.add(dep);
   }
   if(entry.op==="MATCH"){
    validateScopedMatchSpec({
     query:entry.query,fields:entry.fields,mode:entry.mode
    });
   }else if(Object.hasOwn(entry,"query")||Object.hasOwn(entry,"fields")||
            Object.hasOwn(entry,"mode"))bad("TOOL_PLAN_MATCH_FIELDS_WRONG_TRANSFORM");
   if(entry.op==="TAKE"&&(!Number.isInteger(entry.count)||entry.count<1||entry.count>1000))
    bad("TOOL_PLAN_TAKE_INVALID");
   if(entry.op==="SORT"){
    safePath(entry.path);
    if(!["asc","desc"].includes(entry.direction))bad("TOOL_PLAN_SORT_INVALID");
   }
   if(entry.op==="PICK")safePath(entry.path);
   if(entry.op==="UNIQUE"){
    safePath(entry.path);
    if(!entry.path.length)bad("TOOL_PLAN_UNIQUE_KEY_PATH_REQUIRED");
   }
   steps.push({...entry,type:"E",capabilityId:"LOCAL",action:"Typed "+entry.op+" over step "+entry.source.step});
  }else bad("TOOL_PLAN_STEP_KIND_INVALID");
  if([...referenced].some(id=>!seen.has(id))||
      referenced.size!==entry.deps.length||
      entry.deps.some(id=>!referenced.has(id)))
   bad("TOOL_PLAN_UNDECLARED_DATA_DEPENDENCY");
  seen.set(entry.id,entry);
 }
 ownKeys(plan.output,["step","path","format"],"TOOL_PLAN_OUTPUT_INVALID");
 if(!seen.has(plan.output.step))bad("TOOL_PLAN_OUTPUT_SOURCE_INVALID");
 safePath(plan.output.path);
 if(!["text","json"].includes(plan.output.format))bad("TOOL_PLAN_OUTPUT_FORMAT_INVALID");
 if(plan.outputs!==undefined){
  if(!Array.isArray(plan.outputs)||plan.outputs.length<2||plan.outputs.length>8)
   bad("TOOL_PLAN_G2A_OUTPUTS_INVALID");
  const selectedOutputs=new Set();
  let includesPrimary=false;
  for(const item of plan.outputs){
   ownKeys(item,["step","path","format","label"],"TOOL_PLAN_G2A_OUTPUT_INVALID");
   if(!seen.has(item.step)||selectedOutputs.has(item.step)||
      typeof item.label!=="string"||!item.label.trim()||item.label.length>120||
      !["text","json"].includes(item.format))bad("TOOL_PLAN_G2A_OUTPUT_INVALID");
   safePath(item.path);selectedOutputs.add(item.step);
   if(item.step===plan.output.step&&
      JSON.stringify(item.path)===JSON.stringify(plan.output.path)&&
      item.format===plan.output.format)includesPrimary=true;
  }
  if(!includesPrimary)bad("TOOL_PLAN_G2A_PRIMARY_OUTPUT_MISSING");
 }
 if(!Array.isArray(plan.checks)||plan.checks.length<1||plan.checks.length>32)
  bad("TOOL_PLAN_TESTABLE_POSTCONDITIONS_REQUIRED");
 let checksFinalOutput=false;
 for(const check of plan.checks){
  ownKeys(check,["step","path","op","value"],"TOOL_PLAN_CHECK_FIELDS_INVALID");
  if(!seen.has(check.step))bad("TOOL_PLAN_CHECK_STEP_INVALID");
  safePath(check.path);
  if(!CHECKS.has(check.op))bad("TOOL_PLAN_CHECK_OPERATION_INVALID");
  const valueRequired=!["exists","non_empty","sorted_asc","sorted_desc"].includes(check.op);
  if(valueRequired){
   if(check.value===undefined||(!["boolean","string","number"].includes(typeof check.value))||
      (typeof check.value==="number"&&!Number.isFinite(check.value)))
    bad("TOOL_PLAN_CHECK_VALUE_INVALID");
  }else if(Object.hasOwn(check,"value"))bad("TOOL_PLAN_CHECK_VALUE_UNEXPECTED");
  if(["count_equal","count_at_least"].includes(check.op)&&
     (!Number.isInteger(check.value)||check.value<0||check.value>100000))
   bad("TOOL_PLAN_CHECK_COUNT_INVALID");
  if(["sorted_asc","sorted_desc"].includes(check.op)&&check.path.length===0)
   bad("TOOL_PLAN_SORT_CHECK_PATH_REQUIRED");
  if(check.step===plan.output.step)checksFinalOutput=true;
 }
 if(!checksFinalOutput)bad("TOOL_PLAN_FINAL_OUTPUT_CHECK_REQUIRED");
 // Validate every path whose source shape is provable BEFORE any provider
 // dispatch. This also covers final output, checks and data-flow refs.
 for(const step of steps){
  if(step.kind==="TRANSFORM"){
   const producer=steps.find(s=>s.id===step.source.step);
   checkKnownPath(knownOutputShape(producer),step.source.path);
   if(step.op==="FILTER"&&isReference(step.predicate.value)){
    const p=steps.find(s=>s.id===step.predicate.value.$ref.step);
    checkKnownPath(knownOutputShape(p),step.predicate.value.$ref.path);
   }
  }
  if(step.kind==="TOOL"){
   if(step.mode==="EACH"){
    const producer=steps.find(s=>s.id===step.source.step);
    if(knownOutputShape(producer)!=="array")
     bad("TOOL_PLAN_EACH_SOURCE_NOT_TYPED_ARRAY");
    checkKnownPath(knownOutputShape(producer),step.source.path);
    continue;
   }
   const walk=v=>{
    if(isReference(v)){
     const p=steps.find(s=>s.id===v.$ref.step);
     checkKnownPath(knownOutputShape(p),v.$ref.path);
    }else if(Array.isArray(v))for(const x of v)walk(x);
    else if(object(v))for(const x of Object.values(v))walk(x);
   };
   walk(step.args);
  }
 }
 const byId=new Map(steps.map(step=>[step.id,step]));
 for(const step of steps)validateWriterPlanStep(step,{byId});
 // A media extractor in the admitted DAG is never optional evidence:
 // summarizing metadata of the source record instead of the extracted
 // content is a different task, even if the writer returns attractive text.
 const audioSteps=steps.filter(step=>step.kind==='TOOL'&&
  catalogRoute(step.capabilityId)?.cfName==='audio_transcribe');
 if(audioSteps.length){
  for(const step of steps){
   if(step.kind!=='TOOL'||step.capabilityId!==DEXA_TEXT_WRITER_ID||
      !['summarize','answer_from_sources'].includes(step.args?.operation))
    continue;
   const ref=step.args.source?.$ref;
   let source=byId.get(ref?.step),seen=new Set();
   while(source?.kind==='TRANSFORM'&&!seen.has(source.id)){
    seen.add(source.id);source=byId.get(source.source?.step);
   }
   if(!source||!audioSteps.some(a=>a.id===source.id))
    bad('DEXA_MEDIA_SUMMARY_MUST_USE_EXTRACTED_CONTENT');
   // In the single-CF batch contract only a terminal file transcript
   // (or a typed projection of it) can become writer text.
   if(source.id===ref?.step&&
      JSON.stringify(ref?.path?.slice(0,1))!=='["files"]')
    bad('DEXA_MEDIA_SUMMARY_TRANSCRIPT_PATH_REQUIRED');
  }
 }
 const primary=steps.find(s=>s.id===plan.output.step);
 if(primary?.capabilityId===DEXA_TEXT_WRITER_ID&&
    (JSON.stringify(plan.output.path)!=='["text"]'||
     plan.output.format!=='text'||plan.answer?.kind!=='text'))
  bad('DX001_WRITER_FINAL_TEXT_CONTRACT_REQUIRED');
 checkKnownPath(knownOutputShape(primary),plan.output.path);
 for(const entry of plan.outputs||[]){
  checkKnownPath(knownOutputShape(steps.find(s=>s.id===entry.step)),entry.path);
 }
 for(const check of plan.checks)
  checkKnownPath(knownOutputShape(steps.find(s=>s.id===check.step)),check.path);
 const answer=validateAnswerContract(plan.answer,plan,steps);
 if(plan.outputs?.some(item=>!plan.checks.some(check=>check.step===item.step)))
  bad("TOOL_PLAN_G2A_OUTPUT_CHECK_REQUIRED");
 return Object.freeze({schema:TOOL_PLAN_SCHEMA,steps,output:plan.output,
  ...(plan.outputs===undefined?{}:{outputs:plan.outputs}),checks:plan.checks,
  ...(answer===null?{}:{answer})});
}
export function getAt(data,path){
 safePath(path);
 let cur=data;
 for(const part of path){
  if(cur===null||cur===undefined||
     !Object.hasOwn(Object(cur),part))bad("TOOL_PLAN_DATA_PATH_MISSING");
  cur=cur[part];
 }
 return cur;
}
function cloneDeep(x){
 return JSON.parse(JSON.stringify(x));
}
export function resolveStepArgs(args,results){
 const resolve=(value,depth=0)=>{
  if(depth>9)bad("TOOL_PLAN_REFERENCE_TOO_DEEP");
  if(object(value)&&Object.hasOwn(value,"$ref")&&!isReference(value))
   bad("TOOL_PLAN_REFERENCE_INVALID");
  if(isReference(value)){
   const id=value.$ref.step;
   if(!results.has(id))bad("TOOL_PLAN_DEPENDENCY_NOT_READY");
   return cloneDeep(getAt(results.get(id),value.$ref.path));
  }
  if(Array.isArray(value))return value.map(x=>resolve(x,depth+1));
  if(object(value)){
   const result={};
   for(const [k,v] of Object.entries(value)){
    if(DENIED_FIELDS.has(k)||k.startsWith("__"))bad("TOOL_PLAN_ARGUMENT_KEY_UNSAFE");
    result[k]=resolve(v,depth+1);
   }
   return result;
  }
  return value;
 };
 return resolve(args);
}
export function normalizeExact(value){
 return String(value??"").normalize("NFKC").replace(/[\u064a\u0649]/g,"ی")
  .replace(/\u0643/g,"ک").replace(/[\u200c\u200d\u064b-\u065f\s]/g,"").toLocaleLowerCase();
}
function predicateMatch(record,p,{allowMissingOptionalField=false}={}){
 if(p.op==="exists"){
  try{return getAt(record,p.path)!==null&&getAt(record,p.path)!==undefined}
  catch{return false}
 }
 let item;
 try{item=getAt(record,p.path)}
 catch(e){
  // Absence is a non-match ONLY when the executor proved that this exact
  // projected provider field is optional. Unproven/missing identities,
  // required fields and all other paths still fail closed.
  if(allowMissingOptionalField&&e?.code==='TOOL_PLAN_DATA_PATH_MISSING')
   return false;
  throw e;
 }
 switch(p.op){
  case "equal":return item===p.value;
  case "in":return p.value.includes(item);
  case "not_equal":return item!==p.value;
  case "normalized_equal":return normalizeExact(item)===normalizeExact(p.value);
  case "contains":return String(item).includes(String(p.value));
  case "greater":return typeof item==="number"&&item>p.value;
  case "less":return typeof item==="number"&&item<p.value;
  default:bad("TOOL_PLAN_PREDICATE_OPERATOR_INVALID");
 }
}
export function verifyTypedPostconditions(plan,results){
 const checks=[];
 for(const [index,check] of plan.checks.entries()){
  let actual,ok=false;
  try{
   actual=getAt(results.get(check.step),check.path);
   switch(check.op){
    case "exists":ok=actual!==null&&actual!==undefined;break;
    case "non_empty":ok=typeof actual==="string"?actual.trim().length>0:
      Array.isArray(actual)?actual.length>0:
      actual!==null&&actual!==undefined&&
      (typeof actual==="object"?Object.keys(actual).length>0:true);break;
    case "equal":ok=actual===check.value;break;
    case "not_equal":ok=actual!==check.value;break;
    case "normalized_equal":ok=normalizeExact(actual)===normalizeExact(check.value);break;
    case "count_equal":ok=Array.isArray(actual)&&actual.length===check.value;break;
    case "count_at_least":ok=Array.isArray(actual)&&actual.length>=check.value;break;
    case "all_equal":ok=Array.isArray(actual)&&actual.length>0&&actual.every(x=>x===check.value);break;
    case "sorted_asc":case "sorted_desc":
     ok=Array.isArray(actual)&&actual.every((v,i)=>{
      if(!i)return true;
      const previous=actual[i-1];
      if(typeof v==="number"&&typeof previous==="number")
       return check.op==="sorted_asc"?previous<=v:previous>=v;
      const comparison=String(previous).localeCompare(String(v));
      return check.op==="sorted_asc"?comparison<=0:comparison>=0;
     });break;
    default:bad("TOOL_PLAN_CHECK_OPERATION_INVALID");
   }
  }catch{ok=false}
  checks.push({index,step:check.step,op:check.op,passed:ok});
 }
 return Object.freeze({ok:checks.every(x=>x.passed),checks});
}
export function applyTypedTransform(step,results,{
 onMatch=()=>{},uniqueIdentityLabel=false,allowMissingOptionalField=false
}={}){
 if(step.kind!=="TRANSFORM")bad("TOOL_PLAN_NOT_TRANSFORM");
 const source=getAt(results.get(step.source.step),step.source.path);
 switch(step.op){
  case "MATCH":{
   const matched=scopedMatchOne(source,{
    query:step.query,fields:step.fields,mode:step.mode
   });
   onMatch(matched.evidence);
   return matched.value;
  }
  case "FILTER":{
   if(!Array.isArray(source))bad("TOOL_PLAN_FILTER_EXPECTS_ARRAY");
   const predicate=isReference(step.predicate.value)?
    {...step.predicate,value:resolveStepArgs(step.predicate.value,results)}:
    step.predicate;
   if(uniqueIdentityLabel){
    // In an identity-collection FILTER -> ONLY contract, compare the
    // provider's complete observed labels in BOTH scripts with the same
    // deterministic one-winner rule used by MATCH. This never applies to
    // ordinary text filters, count aggregation or arbitrary collections.
    const r=scopedMatchOne(source,{query:predicate.value,
     fields:[predicate.path],mode:"safe_unique"});
    onMatch(r.evidence);
    return [r.value];
   }
   return source.filter(x=>predicateMatch(x,predicate,{allowMissingOptionalField}));
  }
  case "UNIQUE":{
   if(!Array.isArray(source)||source.length>500)
    bad("TOOL_PLAN_UNIQUE_EXPECTS_BOUNDED_ARRAY");
   const seen=new Set(),out=[];
   for(const row of source){
    const value=getAt(row,step.path);
    if(!(["string","number"].includes(typeof value))||
       (typeof value==="string"&&!value.trim())||
       (typeof value==="number"&&!Number.isFinite(value)))
     bad("TOOL_PLAN_UNIQUE_KEY_UNVERIFIED");
    const key=JSON.stringify(value);
    if(!seen.has(key)){seen.add(key);out.push(row)}
   }
   return out;
  }
  case "ONLY":
   if(!Array.isArray(source)||source.length!==1)bad("TOOL_PLAN_UNIQUE_RESULT_REQUIRED");
   return source[0];
  case "TAKE":
   if(!Array.isArray(source))bad("TOOL_PLAN_TAKE_EXPECTS_ARRAY");
   return source.slice(0,step.count);
  case "REVERSE":
   if(!Array.isArray(source))bad("TOOL_PLAN_REVERSE_EXPECTS_ARRAY");
   return [...source].reverse();
  case "SORT":
   if(!Array.isArray(source))bad("TOOL_PLAN_SORT_EXPECTS_ARRAY");
   return [...source].sort((a,b)=>{
    const x=getAt(a,step.path),y=getAt(b,step.path);
    const cmp=typeof x==="number"&&typeof y==="number"?x-y:
      String(x).localeCompare(String(y));
    return step.direction==="desc"?-cmp:cmp;
   });
  case "PICK":return getAt(source,step.path);
  case "COUNT":
   if(!Array.isArray(source))bad("TOOL_PLAN_COUNT_EXPECTS_ARRAY");
   return source.length;
  default:bad("TOOL_PLAN_TRANSFORM_UNKNOWN");
 }
}
