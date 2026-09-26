#!/usr/bin/env bash
set -euo pipefail
SERVER=capability-fabric-onshape-server
docker exec -i "$SERVER" node --input-type=module <<'NODE'
import fs from "node:fs";
const spec=JSON.parse(fs.readFileSync("/openapi/onshape-openapi.json","utf8"));
const op=spec.paths?.["/documents/{did}/workspaces/{wid}/copy"]?.post;
if(!op||op.operationId!=="copyWorkspace") throw new Error("copyWorkspace missing");
const body=op.requestBody?.content?.["application/json"]?.schema;
console.log("CF_COPY_SCHEMA_REF="+JSON.stringify(body));
function deref(s){
 if(!s||typeof s!=="object") return s;
 if(s.$ref){
  const parts=s.$ref.replace(/^#\//,"").split("/");
  let x=spec; for(const p of parts) x=x?.[p];
  return x;
 }
 return s;
}
const bs=deref(body);
console.log("CF_COPY_SCHEMA="+JSON.stringify(bs));
for(const [code,r] of Object.entries(op.responses||{})){
  const rs=r?.content?.["application/json"]?.schema;
  if(rs) console.log("CF_COPY_RESPONSE_"+code+"="+JSON.stringify({schema:rs,resolved:deref(rs)}));
}
console.log("CF_COPY_OPENAPI_VERSION="+String(spec.info?.version||""));
console.log("CF_COPY_SERVER="+String(spec.servers?.[0]?.url||""));
NODE
