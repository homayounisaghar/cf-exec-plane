import test from "node:test";
import assert from "node:assert/strict";
import {catalogCounts,catalogRoute,catalogList,inputSchemaFor,admitCatalogCall} from "./dexa_catalog_registry.mjs";

test("Kata and Rana have one current ASR route and 187 CF definitions",()=>{
  assert.equal(catalogCounts().catalog,291);
  assert.equal(catalogCounts().cfMapped,187);
  assert.equal(catalogRoute("tool.cf.telegram_transcribe"),null);
  const r=catalogRoute("tool.cf.audio_transcribe");
  assert.equal(r.cfName,"audio_transcribe");
  assert.match(r.description,/۱ تا ۲۰/);
  const audio=catalogList({oauthConnected:true}).filter(x=>x.id==="tool.cf.audio_transcribe");
  assert.equal(audio.length,1);
  assert.equal(audio[0].executableNow,true);
});
test("The ASR schema accepts one or twenty, but no obsolete speed fields",()=>{
  const id="tool.cf.audio_transcribe";
  const schema=inputSchemaFor(id);
  assert.deepEqual(Object.keys(schema.properties),["files","batch_id"]);
  assert.equal(schema.properties.files.minItems,1);
  assert.equal(schema.properties.files.maxItems,20);
  assert.deepEqual(Object.keys(schema.properties.files.items.properties),
   ["client_file_id","file","upload_id","telegram_message_handle"]);
  const tg="tgmsg:01234567-89ab-4cde-9123-0123456789ab";
  for(const n of [1,20]){
    const args={files:Array.from({length:n},(_,i)=>({
      client_file_id:"voice-"+i,telegram_message_handle:tg
    }))};
    assert.equal(admitCatalogCall({capabilityId:id,args}).args.files.length,n);
  }
  for(const args of [
    {files:[]},
    {files:Array.from({length:21},()=>({telegram_message_handle:tg}))},
    {files:[{telegram_message_handle:tg}],speed_factor:16},
    {files:[{telegram_message_handle:tg}],parallelism_per_file:514},
    {file:"old-single-file"},
  ]){
    assert.throws(()=>admitCatalogCall({capabilityId:id,args}),
      e=>e.code==="CATALOG_ARGUMENTS_SCHEMA_INVALID");
  }
  const r=inputSchemaFor("tool.cf.telegram_reaction_get");
  assert.equal(Object.hasOwn(r.properties,"speed_factor"),false);
});
