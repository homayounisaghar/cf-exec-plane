// Declared native material effect adapters. Only authenticated CF dispatch
// may call these; they cannot turn a dry run or an uncertain send into success.
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const HEX=/^[a-f0-9]{64}$/;
const STAGE_TOOLS=new Set(['wechat_file_upload','wechat_file_upload_chunk']);
const isRecord=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export function nativeMaterialEffectProof({route,response,requestArgs}={}){
 if(!isRecord(response)||typeof route?.cfName!=='string')return null;
 if(STAGE_TOOLS.has(route.cfName)){
  if(response.provider!=='wechat'||response.state!=='ACHIEVED'||
    response.realization!=='SHARED_MATERIAL_STAGING_ONLY'||
    response.provider_send_performed!==false||
    (route.cfName==='wechat_file_upload'&&requestArgs?.action==='create'&&
      (typeof response.upload_id!=='string'||!HEX.test(response.upload_id)))||
    (route.cfName!=='wechat_file_upload'||requestArgs?.action!=='create')&&
      (typeof requestArgs?.upload_id!=='string'||!HEX.test(requestArgs.upload_id)))
   return null;
  if(route.cfName==='wechat_file_upload_chunk'&&
    response.upload_id!==undefined&&response.upload_id!==requestArgs?.upload_id)return null;
  return Object.freeze({schema:'dexa.provider-effect-proof.v1',
   capabilityId:route.id,providerTool:route.cfName,
   outcome:'PROVIDER_REPORTED_SUCCEEDED',resultDigest:sha(response),
   receiptBasis:'AUTHENTICATED_CF_MATERIAL_STAGE_ONLY',
   independentlyReconciled:false});
 }
 if(route.cfName==='wechat_file_send'){
  if(response.provider!=='wechat'||response.state!=='UI_OUTBOUND_OBSERVED'||
    response.direction!=='out'||response.fresh_outbound_row!==true||
    response.send_enabled_after!==false||!Number.isInteger(response.send_clicks)||
    response.send_clicks<0||response.send_clicks>1||
    response.provider_send_performed!==true||
    response.provider_confirmed!==false||
    response.blind_retry_safe!==false||
    response.target!==requestArgs?.target||
    (typeof requestArgs?.upload_id!=='string'||!HEX.test(requestArgs.upload_id))||
    typeof response.sha256_hex!=='string'||!HEX.test(response.sha256_hex)||
    !Number.isInteger(response.size_bytes)||response.size_bytes<1)
   return null;
  return Object.freeze({schema:'dexa.provider-effect-proof.v1',
   capabilityId:route.id,providerTool:route.cfName,
   outcome:'PROVIDER_REPORTED_SUCCEEDED',resultDigest:sha(response),
   receiptBasis:'CF_NATIVE_UI_FRESH_OUTBOUND_ONLY_NOT_PROVIDER_DELIVERY',
   independentlyReconciled:false});
 }
 return null;
}
