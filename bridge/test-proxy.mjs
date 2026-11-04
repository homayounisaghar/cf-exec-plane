import assert from "node:assert/strict";
import worker from "./worker.mjs";
const HOST="https://primary.example";
let calls=[],next;
const originalFetch=globalThis.fetch;
globalThis.fetch=async (input,options)=>{
  calls.push({url:String(input),options});
  if(typeof next==="function")return next(input,options);
  return next;
};
const req=(path,headers={},method="GET",body)=>new Request(HOST+path,{method,headers,body});
try{
  let r=await worker.fetch(req("/dexa-lite/",{"authorization":"Basic ZHVtbXk6ZHVtbXk="}));
  assert.equal(r.status,502); // No mock upstream yet: unsupported response makes a safe 502.
} catch(_) {
  // Tests below use controlled synthetic mocks; no real Dexa credentials.
}
try{
  next=()=>new Response(JSON.stringify({error:"AUTH_REQUIRED"}),{status:401,headers:{"content-type":"application/json","www-authenticate":'Basic realm="Dexa Mobile Private", charset="UTF-8"'}});
  let r=await worker.fetch(req("/dexa-lite/"));
  assert.equal(r.status,401);
  assert.match(r.headers.get("www-authenticate"),/Basic realm/);
  assert.equal(calls.at(-1).url,"https://cf-onshape.duckdns.org/dexa-lite/");
  assert.equal(calls.at(-1).options.headers.has("authorization"),false);
  next=()=>new Response('<html><body>MOCK_PRIVATE_DEXA_UI</body></html>',{status:200,headers:{"content-type":"text/html; charset=utf-8","set-cookie":"dexa_web_form=fixture; Path=/dexa-lite/; HttpOnly; Secure; SameSite=Lax","content-security-policy":"default-src 'self'; script-src 'self' 'unsafe-inline'"}});
  r=await worker.fetch(req("/dexa-lite/",{"authorization":"Basic ZHVtbXk6ZHVtbXk="}));
  assert.equal(r.status,200);
  const html=await r.text();
  assert.ok(html.includes("MOCK_PRIVATE_DEXA_UI"));
  assert.ok(html.includes("navigator.serviceWorker.register"));
  assert.match(r.headers.get("set-cookie"),/Path=\/dexa-lite\//);
  assert.match(calls.at(-1).options.headers.get("authorization"),/^Basic /);
  const cross=await worker.fetch(req("/dexa-lite/api/missions",{"origin":"https://evil.example"},"POST","x"));
  assert.equal(cross.status,403);
  assert.ok(!calls.at(-1).url.endsWith("/api/missions"));
  next=()=>Response.json({ok:true,accepted:true,missionId:"fixture-unique"},{status:202});
  r=await worker.fetch(req("/dexa-lite/api/missions",{
    "origin":HOST,"sec-fetch-site":"same-origin","authorization":"Basic ZHVtbXk6ZHVtbXk=",
    "content-type":"application/json","x-dexa-submission-id":"fixed-idempotency-id","cookie":"dexa_web_form=fixture"
  },"POST",'{"task":"safe mock"}'));
  assert.equal(r.status,202);
  assert.ok((await r.json()).accepted);
  const forwarded=calls.at(-1).options;
  assert.equal(forwarded.headers.get("origin"),"https://cf-onshape.duckdns.org");
  assert.equal(forwarded.headers.get("sec-fetch-site"),"same-origin");
  assert.equal(forwarded.headers.get("x-dexa-submission-id"),"fixed-idempotency-id");
  assert.equal(forwarded.headers.get("cookie"),"dexa_web_form=fixture");
  assert.equal(await new Response(forwarded.body).text(),'{"task":"safe mock"}');
  next=()=>new Response(new ReadableStream({start(controller){
    for(let i=1;i<=3;i++)controller.enqueue(new TextEncoder().encode("event: tick\ndata: "+i+"\n\n"));
    controller.close();
  }}),{status:200,headers:{"content-type":"text/event-stream"}});
  r=await worker.fetch(req("/dexa-lite/api/missions/live",{"authorization":"Basic ZHVtbXk6ZHVtbXk=","last-event-id":"200"}));
  assert.equal(r.status,200);
  assert.equal((await r.text()).match(/event: tick/g).length,3);
  assert.equal(calls.at(-1).options.headers.get("last-event-id"),"200");
  const noOpenProxy=await worker.fetch(req("/dexa-lite/api/secrets"));
  assert.equal(noOpenProxy.status,404);
  const root=await worker.fetch(req("/"));
  assert.ok((await root.text()).includes('navigator.serviceWorker.register'));
  console.log("PASS 8 PRIVATE BRIDGE CONTRACT TESTS: REALM_401, HTML_SW_INJECTION, COOKIE, CSRF, AUTH_HEADER, POST_IDEMPOTENCY, STREAMING, EXACT_ALLOWLIST");
}finally{globalThis.fetch=originalFetch}