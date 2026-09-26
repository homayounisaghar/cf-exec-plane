#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
docker exec -i "$SERVER" node --input-type=module <<'NODE'
import fs from "node:fs";
const spec=JSON.parse(fs.readFileSync("/openapi/onshape-openapi.json","utf8"));
const op=spec.paths?.["/documents/{did}/workspaces/{wid}/copy"]?.post;
if(!op||op.operationId!=="copyWorkspace") throw new Error("copyWorkspace missing");
function deref(s){
 if(!s||typeof s!=="object") return s;
 if(s.$ref){
  const parts=s.$ref.replace(/^#\//,"").split("/");
  let x=spec; for(const p of parts) x=x?.[p];
  return x;
 }
 return s;
}
console.log("CF_COPY_REQUEST_BODY_KEYS="+JSON.stringify(Object.keys(op.requestBody?.content||{})));
for(const [media,v] of Object.entries(op.requestBody?.content||{})){
  const schema=v?.schema;
  console.log("CF_COPY_SCHEMA_MEDIA="+media);
  console.log("CF_COPY_SCHEMA_REF="+JSON.stringify(schema));
  console.log("CF_COPY_SCHEMA="+JSON.stringify(deref(schema)));
}
for(const [code,r] of Object.entries(op.responses||{})){
  for(const [media,v] of Object.entries(r?.content||{})){
    const schema=v?.schema;
    console.log("CF_COPY_RESPONSE="+JSON.stringify({code,media,schema,resolved:deref(schema)}));
  }
}
console.log("CF_COPY_OPENAPI_VERSION="+String(spec.info?.version||""));
console.log("CF_COPY_SERVER="+String(spec.servers?.[0]?.url||""));
NODE
