import http from "node:http";
import {randomBytes} from "node:crypto";

// Standalone, TEST-ONLY GET-to-server receipt experiment.
// No Dexa, CF, Rana, ChatGPT API, user credentials or third-party tools.
const runs = new Map();
const TTL_MS = 20 * 60 * 1000;
const READY_DELAY_MS = 4000;
const MAX_RUNS = 128;
const casePattern = /^[A-Za-z0-9_-]{16,64}$/;
const valuePattern = /^[A-Za-z0-9_-]{1,64}$/;

function text(res, code, data) {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer"
  });
  res.end(data + "\n");
}
function compact() {
  const now=Date.now();
  for(const [id, item] of runs) if(now-item.created>TTL_MS) runs.delete(id);
}
function checkCase(url, res) {
  const id=url.searchParams.get("case")||"";
  if (!casePattern.test(id)) {
    text(res, 400, "ERROR=INVALID_CASE\nA case must be 16-64 ASCII letters, numbers, _ or -.");
    return null;
  }
  return id;
}
function guide(origin) {
  return [
    "INSTANT WEB GET CLOSED-LOOP MVP V1 - TEST DATA ONLY",
    "This experiment proves whether a browsing-only ChatGPT model can deliver one short ASCII value to a server by opening an HTTP GET URL and then retrieve a server-only receipt.",
    "No connectors, logins, model API calls, actions on user services, or Dexa catalog are involved.",
    "Never send personal data, credentials, recipes, chat transcripts or confidential information to these PUBLIC test URLs.",
    "A user prompt provides CASE (16-64 ASCII letters/digits/_/-) and VALUE (1-64 ASCII letters/digits/_/-).",
    "Do the following with your actual web browsing tool, NOT by merely describing URLs:",
    "1. Open exactly: "+origin+"/submit?case=CASE&value=VALUE",
    "   Replace CASE and VALUE with literal user-provided ASCII strings. Confirm the fetched page says STATE=SUBMITTED. The receipt is NOT on the submit page.",
    "2. Open: "+origin+"/status?case=CASE&poll=1",
    "   If STATE=WAIT, open again changing poll to 2, 3, etc, up to 8 polls. Use genuinely fresh fetches. Do not pretend a page was fetched.",
    "3. Only after STATE=READY, open: "+origin+"/result?case=CASE&fetch=1",
    "   Read SERVER_RECEIPT and SERVER_RESULT from THAT response.",
    "4. Reply to the user with exactly these two lines, copied from the result page:",
    "   SERVER_RECEIPT=<actual code>",
    "   SERVER_RESULT=<actual result>",
    "If a fetch is unavailable, returns an error or is blocked, reply FAILED_WEB_FETCH and state which step failed. Never invent a receipt or result.",
    "A receipt is random and cannot be derived from VALUE; success requires really fetching the server's result page.",
    "All URLs are public test endpoints; responses are short, plain text, and no-store.",
    "Reusing a CASE with a different VALUE is rejected; ask for a fresh CASE."
  ].join("\n");
}
function createServer() {
  return http.createServer((req,res)=>{
    try {
      if(req.method!=="GET") return text(res, 405, "ERROR=GET_ONLY");
      if((req.url||"").length>1000) return text(res, 414, "ERROR=URL_TOO_LONG");
      const url=new URL(req.url||"/", "http://localhost");
      const path=url.pathname;
      if(path==="/health") return text(res, 200, "STATE=HEALTHY\nSERVICE=INSTANT_GET_LOOP_V1");
      const rawHost=String(req.headers.host||"").toLowerCase();
      const host=/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(rawHost)?rawHost:"invalid-host";
      if(path==="/" || path==="/guide") return text(res, 200, guide("https://"+host));
      if(path==="/robots.txt") return text(res, 200, "User-agent: *\nDisallow: /");
      if(!["/submit","/status","/result","/audit"].includes(path))
        return text(res, 404, "ERROR=UNKNOWN_ROUTE");
      compact();
      const caseId=checkCase(url,res);
      if(caseId===null) return;
      let run=runs.get(caseId);
      if(path==="/submit") {
        const value=url.searchParams.get("value")||"";
        if(!valuePattern.test(value)) return text(res,400,"ERROR=INVALID_VALUE\nOnly 1-64 ASCII letters/digits/_/- are accepted.");
        if(run && run.value!==value) return text(res,409,"ERROR=CASE_ALREADY_USED_WITH_ANOTHER_VALUE");
        if(!run) {
          if(runs.size>=MAX_RUNS) return text(res,503,"ERROR=TEST_CAPACITY");
          run={created:Date.now(),ready:Date.now()+READY_DELAY_MS,value,
            receipt:randomBytes(8).toString("hex").toUpperCase(),
            submitHits:0,statusHits:0,resultHits:0};
          runs.set(caseId,run);
        }
        run.submitHits++;
        return text(res,200,"STATE=SUBMITTED\nCASE="+caseId+"\nRECEIPT=NOT_AVAILABLE_HERE\nNEXT=/status?case="+caseId+"&poll=1");
      }
      if(!run) return text(res,404,"STATE=NOT_FOUND\nCASE="+caseId);
      const ready=Date.now()>=run.ready;
      if(path==="/status") {
        run.statusHits++;
        return text(res,200,"STATE="+(ready?"READY":"WAIT")+"\nCASE="+caseId+
          "\nRECEIPT=NOT_AVAILABLE_HERE"+(ready?"\nNEXT=/result?case="+caseId+"&fetch=1":"\nPOLL_AGAIN_WITH_NEW_POLL_NUMBER"));
      }
      if(path==="/result") {
        run.resultHits++;
        if(!ready) return text(res,200,"STATE=WAIT\nRECEIPT=NOT_AVAILABLE_HERE");
        return text(res,200,"STATE=READY\nCASE="+caseId+
          "\nSERVER_RECEIPT="+run.receipt+
          "\nSERVER_RESULT="+run.value.split("").reverse().join("").toUpperCase());
      }
      if(path==="/audit") return text(res,200,"CASE="+caseId+
        "\nSTATE="+(ready?"READY":"WAIT")+
        "\nSUBMIT_HITS="+run.submitHits+
        "\nSTATUS_HITS="+run.statusHits+
        "\nRESULT_HITS="+run.resultHits+
        "\nRECEIPT_VISIBLE_HERE=NO");
    } catch(err) {
      process.stderr.write("INSTANT_GET_LOOP_ERROR "+String(err?.message||err)+"\n");
      if(!res.headersSent) text(res,500,"ERROR=INTERNAL_ERROR");
      else res.end();
    }
  });
}
const port=Number(process.env.PORT||10000);
createServer().listen(port,"0.0.0.0",()=>console.log("INSTANT_GET_LOOP_V1 listening on "+port));
