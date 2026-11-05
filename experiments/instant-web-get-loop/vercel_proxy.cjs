// TEST-ONLY alternate HTTPS front door to the same isolated Render receipt store.
// No secrets, no tools, no production actions. All requests are read-only or
// short ASCII test-value submissions. Does not forward arbitrary URLs.
module.exports = async function handler(req,res) {
  const headers={
    "cache-control":"no-store, no-cache, must-revalidate",
    "content-type":"text/plain; charset=utf-8",
    "x-robots-tag":"noindex, nofollow",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer",
  };
  for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
  if(req.method!=="GET")return res.status(405).send("ERROR=GET_ONLY\n");
  const v=x=>typeof x==="string"?x:"";
  const op=v(req.query.op);
  const id=v(req.query.case);
  const value=v(req.query.value);
  const poll=v(req.query.poll);
  const fetchId=v(req.query.fetch);
  const caseOk=/^[A-Za-z0-9_-]{16,64}$/.test(id);
  const valueOk=/^[A-Za-z0-9_-]{1,64}$/.test(value);
  if(op==="guide"){
    const host=v(req.headers.host);
    if(!/^[a-z0-9.-]+$/.test(host))return res.status(400).send("ERROR=HOST");
    return res.status(200).send([
      "INSTANT BROWSE-ONLY GET CLOSED LOOP, ALTERNATE VERCEL HOST",
      "Test data only; do not send secrets or personal records.",
      "You will receive CASE (16-64 ASCII letters/digits/_/-), VALUE (1-64 ASCII letters/digits/_/-).",
      "Use your actual web tool to open these links in order:",
      "1. https://"+host+"/api/relay?op=submit&case=CASE&value=VALUE",
      "2. https://"+host+"/api/relay?op=status&case=CASE&poll=1",
      "   If STATE=WAIT, retry with poll=2, poll=3 ... up to 8.",
      "3. When STATE=READY open https://"+host+"/api/relay?op=result&case=CASE&fetch=1",
      "4. Reply only with the SERVER_RECEIPT and SERVER_RESULT from that result page.",
      "If a browse fetch fails, say FAILED_WEB_FETCH and identify the failed step.",
      "Do not guess results. The server-only receipt is random.",
    ].join("\n")+"\n");
  }
  if(op==="health"){
    try {
      const r=await fetch("https://instant-get-loop-20261105.onrender.com/health",{signal:AbortSignal.timeout(12000)});
      return res.status(r.status).send(await r.text());
    } catch {
      return res.status(502).send("ERROR=UPSTREAM_HEALTH_FAILED\n");
    }
  }
  if(!["submit","status","result","audit"].includes(op))return res.status(404).send("ERROR=UNKNOWN_OP\n");
  if(!caseOk)return res.status(400).send("ERROR=INVALID_CASE\n");
  if(op==="submit"&&!valueOk)return res.status(400).send("ERROR=INVALID_VALUE\n");
  const upstream=new URL("https://instant-get-loop-20261105.onrender.com/"+op);
  upstream.searchParams.set("case",id);
  if(op==="submit")upstream.searchParams.set("value",value);
  if(op==="status")upstream.searchParams.set("poll",/^[0-9]{1,2}$/.test(poll)?poll:"1");
  if(op==="result")upstream.searchParams.set("fetch",/^[0-9]{1,2}$/.test(fetchId)?fetchId:"1");
  try {
    const r=await fetch(upstream,{signal:AbortSignal.timeout(12000),redirect:"error"});
    return res.status(r.status).send(await r.text());
  }catch{
    return res.status(502).send("ERROR=UPSTREAM_TEMPORARY_FAILURE\n");
  }
};