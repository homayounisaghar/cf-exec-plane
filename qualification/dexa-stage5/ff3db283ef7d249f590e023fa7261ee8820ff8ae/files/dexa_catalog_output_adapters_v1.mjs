// Model-facing, audited provider output contracts, keyed by native tool name.
// Each source owns its own adapter metadata. The planner/validator has no
// branching on source name or task phrasing. Unknown tools remain unknown;
// never fabricate shapes for tools that have not been inspected.
import fs from 'node:fs';
import {catalogRoute} from './dexa_catalog_registry.mjs';
const doc=JSON.parse(fs.readFileSync(
 new URL('./dexa_catalog_output_shapes_v1.json',import.meta.url),'utf8'));
if(doc.schema!=='dexa.catalog-output-shapes.v1')throw Error('OUTPUT_CONTRACT_VERSION_INVALID');
export function catalogKnownOutputShape(id){
 const route=catalogRoute(id);
 const record=doc.adapters[route?.cfName];
 if(!record)return null;
 return structuredClone(record);
}
const shapeError=code=>{throw Object.assign(new Error(code),{code})};
const typeName=type=>type==='integer'?'number':type||'unknown';
// Metadata carries provider-observed field names and types. This is a typed
// DAG projection, not a provider-specific answer planner or a second model.
export function projectDocumentedShape(shape,path=[]){
 if(!Array.isArray(path))shapeError('GENERAL_PLAN_PROJECTION_PATH_INVALID');
 let node=shape||{kind:'unknown'};
 for(const token of path){
  if(node.kind==='unknown')return node;
  if(node.kind==='array'){
   if(!Number.isSafeInteger(token)||token<0)
    shapeError('GENERAL_PLAN_ARRAY_INDEX_INVALID');
   node={kind:'record',recordFields:node.recordFields,
    fieldTypes:node.fieldTypes,optionalFields:node.optionalFields};
   continue;
  }
  if(node.kind==='record'){
   if(typeof token!=='string')
    shapeError('GENERAL_PLAN_RECORD_KEY_INVALID');
   if(node.rootArrays){
    const contract=node.rootArrays[token];
    if(contract){
     node={kind:'array',recordFields:contract.fields,
      fieldTypes:contract.fieldTypes||{},
      optionalFields:contract.optionalFields||[]};
     continue;
    }
    // Other root keys may exist but have not been audited: do NOT guess.
    return {kind:'unknown'};
   }
   if(node.recordFields){
    if(!node.recordFields.includes(token))
     shapeError('GENERAL_PLAN_FIELD_NOT_IN_PROVIDER_RECORD');
    node={kind:typeName(node.fieldTypes?.[token])};
    continue;
   }
   return {kind:'unknown'};
  }
  shapeError('GENERAL_PLAN_SCALAR_HAS_NO_CHILD');
 }
 return node;
}
export function describeTypedProjection(steps,producerId,path=[],visited=new Set()){
 if(!Number.isSafeInteger(producerId)||visited.has(producerId))
  return {kind:'unknown'};
 const step=steps.find(s=>s.id===producerId);
 if(!step)return {kind:'unknown'};
 visited.add(producerId);
 let base;
 if(step.kind==='TOOL'){
  if(step.mode==='EACH')base={kind:'array'};
  else{
   const original=catalogKnownOutputShape(step.capabilityId);
   base=original?.arrays?{kind:'record',rootArrays:original.arrays}:
    original?.record?{kind:'record',recordFields:original.record.fields,
     fieldTypes:original.record.fieldTypes||{},
     optionalFields:original.record.optionalFields||[]}:
    {kind:'unknown'};
  }
 }else if(step.kind==='USER_GATE')base={kind:'record',
  recordFields:['answer'],fieldTypes:{answer:'string'}};
 else if(step.kind==='TRANSFORM'){
  const parent=describeTypedProjection(steps,step.source.step,
   step.source.path,visited);
  if(['MATCH','ONLY'].includes(step.op)){
   base=parent.kind==='array'?
    {kind:'record',recordFields:parent.recordFields,
     fieldTypes:parent.fieldTypes}:{kind:'unknown'};
  }else if(['SORT','FILTER','TAKE','REVERSE','UNIQUE'].includes(step.op)){
   base=parent.kind==='array'?parent:{kind:'unknown'};
  }else if(step.op==='COUNT')base={kind:'number'};
  else if(step.op==='PICK')base=projectDocumentedShape(parent,step.path);
  else base={kind:'unknown'};
 }else base={kind:'unknown'};
 return projectDocumentedShape(base,path);
}
// Optional fields are proven by the provider's audited output contract.
// A missing *documented optional* category field means a row is not a
// positive match, never that a fabricated value or unobserved ID is valid.
export function optionalPredicateFieldProven(steps,sourceStep,sourcePath,predicatePath){
 if(!Array.isArray(predicatePath)||predicatePath.length!==1||
    typeof predicatePath[0]!=='string')return false;
 const source=describeTypedProjection(steps,sourceStep,sourcePath);
 return source.kind==='array'&&
  Array.isArray(source.optionalFields)&&
  source.optionalFields.includes(predicatePath[0]);
}
export function shapeForTypedProducer(steps,producerId){
 const p=describeTypedProjection(steps,producerId,[]);
 if(p.kind==='array')return {recordFields:p.recordFields,
  fieldTypes:p.fieldTypes,array:true};
 if(p.kind==='record'&&p.rootArrays)return {arrays:p.rootArrays};
 if(p.kind==='record'&&p.recordFields)return {recordFields:p.recordFields,
  fieldTypes:p.fieldTypes};
 return null;
}
export function assertKnownTypedDataflowFields(typed){
 if(!typed||!Array.isArray(typed.steps))return true;
 const check=(stepId,path)=>describeTypedProjection(
  typed.steps,stepId,path);
 for(const step of typed.steps){
  if(step.kind==='TRANSFORM'){
   check(step.source.step,step.source.path);
   // Validate fields referenced by an ordered/filtered/bounded record.
   const source=check(step.source.step,step.source.path);
   if(step.op==='PICK')
    projectDocumentedShape(source,step.path);
   if(step.op==='SORT'||step.op==='UNIQUE')
    projectDocumentedShape(source.kind==='array'?{kind:'record',
     recordFields:source.recordFields,fieldTypes:source.fieldTypes}:source,
     step.path);
   if(step.op==='FILTER')projectDocumentedShape(
    source.kind==='array'?{kind:'record',
     recordFields:source.recordFields,fieldTypes:source.fieldTypes}:source,
    step.predicate.path);
   if(step.op==='MATCH'&&source.kind==='array')
    for(const field of step.fields)projectDocumentedShape(
     {kind:'record',recordFields:source.recordFields,
      fieldTypes:source.fieldTypes},field);
  }
  if(step.kind!=='TOOL')continue;
  const visit=x=>{
   if(x===null||typeof x!=='object')return;
   if(Object.hasOwn(x,'$ref')){
    check(x.$ref?.step,x.$ref?.path);return;
   }
   for(const v of Object.values(x))visit(v);
  };
  visit(step.args);
 }
 if(typed.output)check(typed.output.step,typed.output.path);
 for(const condition of typed.checks||[])
  check(condition.step,condition.path);
 return true;
}


// Deterministic, provider-owned category semantics. The model may describe a
// logical category using a coarse native field ("type=group") while the
// observed provider contract represents that category via a finer field
// ("peer_kind in [group,supergroup]"). Never infer those mappings from owner
// language or a particular target name: only exact declared adapter mappings
// authorize a rewrite, before ANY provider call.
export function canonicalizeProviderSemanticPredicates(raw){
 if(typeof raw!=="string")throw new Error("CATALOG_SEMANTIC_PLAN_INVALID");
 let doc;
 try{doc=JSON.parse(raw)}catch{return Object.freeze({raw,changed:false})}
 if(!doc||typeof doc!=="object"||!Array.isArray(doc.steps))
  return Object.freeze({raw,changed:false});
 const plan=structuredClone(doc);
 const byId=new Map(plan.steps.map(s=>[s.id,s]));
 const sourceArray=(producerId,path,visited=new Set())=>{
  if(visited.has(producerId))return null;
  visited.add(producerId);
  const producer=byId.get(producerId);
  if(!producer)return null;
  if(producer.kind==="TOOL"){
   if(!Array.isArray(path)||path.length!==1||typeof path[0]!=="string")
    return null;
   return catalogKnownOutputShape(producer.capabilityId)?.arrays?.[path[0]]||null;
  }
  if(producer.kind==="TRANSFORM"&&
     ["FILTER","SORT","TAKE","REVERSE","UNIQUE"].includes(producer.op)&&
     Array.isArray(path)&&path.length===0)
   return sourceArray(producer.source?.step,producer.source?.path,visited);
  return null;
 };
 let changed=0;
 for(const step of plan.steps){
  if(step?.kind!=="TRANSFORM"||step.op!=="FILTER"||
     step.predicate?.op!=="equal"||
     typeof step.predicate.value!=="string"||
     !Array.isArray(step.predicate.path)||step.predicate.path.length!==1)
   continue;
  const contract=sourceArray(step.source?.step,step.source?.path);
  const field=step.predicate.path[0],value=step.predicate.value;
  const mapped=contract?.semanticValueMappings?.[field]?.[value];
  if(!mapped)continue;
  if(!Array.isArray(mapped.path)||mapped.path.length!==1||
     !contract.fields?.includes(mapped.path[0])||
     !["equal","in"].includes(mapped.op)||
     (mapped.op==="in"&&
      (!Array.isArray(mapped.value)||mapped.value.length<2||
       mapped.value.some(x=>typeof x!=="string"||!x)))||
     (mapped.op==="equal"&&
      (typeof mapped.value!=="string"||!mapped.value)))
   throw Object.assign(new Error("CATALOG_SEMANTIC_MAPPING_UNSAFE"),
                       {code:"CATALOG_SEMANTIC_MAPPING_UNSAFE"});
  step.predicate={path:[...mapped.path],op:mapped.op,
    value:structuredClone(mapped.value)};
  changed++;
 }
 return Object.freeze({raw:changed?JSON.stringify(plan):raw,
  changed:changed>0,
  rule:changed?"VERIFIED_PROVIDER_CATEGORY_CANONICALIZATION":null});
}
