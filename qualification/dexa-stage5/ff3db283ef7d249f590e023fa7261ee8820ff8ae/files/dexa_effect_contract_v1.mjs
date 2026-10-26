// Standard catalog effect taxonomy and real authenticated-provider receipts.
// A sole owner's valid mission is the authorization for all BOUND tools.
// No additional Dexa-created approval, whitelist or administrator role.
// Durable dispatch/replay and provider-native OAuth remain necessary for
// correct execution, not for Dexa overriding the owner's tool choice.
import {createHash} from 'node:crypto';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const err=code=>{throw Object.assign(new Error(code),{code})};
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function catalogEffectClass(route){
 if(!route?.cfName)return 'UNBOUND';
 if(route.internalExecutor)return route.internalExecutor==='bounded_public_web'?'READ':'INTERNAL_TEXT';
 if(route.isReadOnly)return route.requiresElevation?'SENSITIVE_READ':'READ';
 if(route.risk==='irreversible')return 'IRREVERSIBLE';
 if(route.risk==='destructive')return 'DESTRUCTIVE';
 return 'WRITE';
}
export function isProviderEffect(route){
 return Boolean(route?.cfName&&!route.internalExecutor&&!route.isReadOnly);
}
const TERMINAL_OK=new Set(['SUCCEEDED','COMPLETED','ACHIEVED']);
const NOT_TERMINAL=new Set(['FAILED','ERROR','BLOCKED','IN_DOUBT',
 'PENDING','QUEUED','ACCEPTED','RUNNING','WAITING']);
const populated=x=>typeof x==='string'?x.trim().length>0:
 Array.isArray(x)?true:obj(x)?true:
 typeof x==='boolean'?x:true&&x!==null&&x!==undefined;
function negativeNested(x){
 return obj(x)&&(x.ok===false||x.isError===true||x.error||
  NOT_TERMINAL.has(String(x.state||x.status||'').toUpperCase()));
}
export function requirePhysicalEffectReceipt({capabilityId,route,response}={}){
 if(!isProviderEffect(route))err('EFFECT_EXPECTED_PHYSICAL_WRITE');
 if(!obj(response))err('EFFECT_PROVIDER_REPLY_MISSING');
 // Recognize two documented CF result families, without special cases for
 // any provider, user, message or operation. HTTP success alone proves
 // nothing. The *authenticated gateway* already dispatched the exact tool.
 let payload,receiptBasis;
 if(TERMINAL_OK.has(response.state)&&
    typeof response.tool==='string'&&obj(response.result)){
  // Legacy CF wrapped-tool result: exact requested native tool identity.
  if(response.tool!==route.cfName||negativeNested(response.result))
   err('EFFECT_PROVIDER_TERMINAL_RESULT_UNVERIFIED');
  payload=response.result;
  receiptBasis='ACTUAL_AUTHENTICATED_PROVIDER_TERMINAL_RESPONSE';
 }else if(response.ok===true&&TERMINAL_OK.has(response.state)&&
    Object.hasOwn(response,'operation')&&populated(response.operation)&&
    Object.hasOwn(response,'provider')&&populated(response.provider)&&
    Object.hasOwn(response,'realization')&&populated(response.realization)&&
    Object.hasOwn(response,'side_effects')&&
    response.side_effects!==undefined&&response.side_effects!==null&&
    response.side_effects!==false&&
    !negativeNested(response.realization)&&
    !negativeNested(response.side_effects)){
  // Native CF operation envelope: {ok,state,operation,provider,realization,
  // observation,side_effects}. A completed *report* of the effect is the
  // provider proof; no independently reconciled external claim is made.
  payload=response;
  receiptBasis='ACTUAL_AUTHENTICATED_CF_OPERATION_TERMINAL_ENVELOPE';
 }else err('EFFECT_PROVIDER_TERMINAL_RESULT_UNVERIFIED');
 return Object.freeze({schema:'dexa.provider-effect-proof.v1',
  capabilityId,providerTool:route.cfName,
  outcome:'PROVIDER_REPORTED_SUCCEEDED',
  resultDigest:digest(payload),receiptBasis,
  independentlyReconciled:false});
}
