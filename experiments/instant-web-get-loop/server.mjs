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

// Browser-only THREE-STAGE probe. This is a separate namespace from v1.
// The only effects are ephemeral receipt counters and a short dummy value.
const probeRuns = new Map();
const PROBE_TTL_MS = 60 * 60 * 1000;
const PROBE_CAP = 128;
function proof() { return randomBytes(12).toString("hex").toUpperCase(); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[c]));
}
function probeHtml(res, code, title, lines, url="", label="Open the next page") {
  const body = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
    + "<meta name=\"robots\" content=\"noindex,noarchive\"><title>"+escapeHtml(title)+"</title></head>"
    + "<body><h1>"+escapeHtml(title)+"</h1><pre>"+escapeHtml(lines.join("\n"))+"</pre>"
    + (url?"<p><a href=\""+escapeHtml(url)+"\">"+escapeHtml(label)+"</a></p>":"")
    + "</body></html>";
  res.writeHead(code, {
    "content-type":"text/html; charset=utf-8",
    "cache-control":"private, no-store, no-cache, must-revalidate, max-age=0",
    "pragma":"no-cache",
    "x-content-type-options":"nosniff",
    "x-robots-tag":"noindex, noarchive",
    "referrer-policy":"no-referrer"
  });
  res.end(body);
}
function handleProbe(req, res, url, path, origin) {
  const id = url.searchParams.get("case") || "";
  if(path==="/probe" || path==="/probe/guide")
    return probeHtml(res,200,"Three-stage web GET probe",[
      "PROTOCOL=THREE_STAGE_WEB_GET_V2",
      "TEST_ONLY=YES",
      "PURPOSE=Read a public HTML page, open its existing clickable link, then construct and open a new URL carrying a harmless value.",
      "OPEN_FIRST="+origin+"/probe/start?case=YOUR_UNIQUE_CASE",
      "CASE must be 16-64 ASCII letters/digits/_/-; VALUE 1-64 ASCII letters/digits/_/-.",
      "On the start page, genuinely open the existing HTML anchor to stage 2.",
      "On the stage 2 page, append VALUE to SUBMIT_PREFIX and open that generated URL.",
      "After accepted submission, follow the result-page link and copy the three server-only proofs.",
      "If the web tool fails, report exactly which stage failed; never invent a proof.",
      "This public experiment MUST NOT be used for secrets, private data, recipes, or any user records."
    ]);
  if(!casePattern.test(id))
    return probeHtml(res,400,"INVALID_CASE",["ERROR=INVALID_CASE"]);
  const now=Date.now();
  for(const [k,r] of probeRuns) if(now-r.created>PROBE_TTL_MS) probeRuns.delete(k);
  let r=probeRuns.get(id);
  if(path==="/probe/start") {
    if(!r) {
      if(probeRuns.size>=PROBE_CAP) return probeHtml(res,503,"LIMIT",["ERROR=PROBE_CAPACITY"]);
      r={created:now,readProof:proof(),ticket:proof(),linkProof:proof(),
        submitProof:proof(),value:null,startHits:0,linkHits:0,submitHits:0,resultHits:0};
      probeRuns.set(id,r);
    }
    r.startHits++;
    const link=origin+"/probe/link?case="+id+"&ticket="+r.ticket;
    return probeHtml(res,200,"Stage 1: Read",[
      "STATE=READ_OK","CASE="+id,"READ_PROOF="+r.readProof,
      "STAGE_2=FOLLOW_THE_ACTUAL_HTML_LINK_BELOW",
      "IMPORTANT=The next URL is a server-authored hyperlink; do not invent a replacement.",
      "STAGE_2_URL="+link
    ],link,"OPEN STAGE 2: EXISTING LINK");
  }
  if(!r) return probeHtml(res,404,"NO_SESSION",["STATE=NOT_FOUND","CASE="+id]);
  if(path==="/probe/link") {
    const ticket=url.searchParams.get("ticket")||"";
    if(ticket!==r.ticket) return probeHtml(res,403,"WRONG_LINK",["ERROR=LINK_TICKET_MISMATCH"]);
    r.linkHits++;
    return probeHtml(res,200,"Stage 2: Link Opened",[
      "STATE=LINK_OPENED","CASE="+id,"LINK_PROOF="+r.linkProof,
      "STAGE_3=BUILD_A_NEW_URL_WITH_THE_USER_VALUE",
      "SUBMIT_PREFIX="+origin+"/probe/send?case="+id+"&ticket="+r.ticket+"&value=",
      "ACTION=Append VALUE immediately after the equals sign and actually browse the resulting URL.",
      "VALUE_MUST_BE_SHORT_PUBLIC_TEST_DATA=YES"
    ]);
  }
  if(path==="/probe/send") {
    const ticket=url.searchParams.get("ticket")||"";
    const value=url.searchParams.get("value")||"";
    if(ticket!==r.ticket) return probeHtml(res,403,"WRONG_TICKET",["ERROR=LINK_TICKET_MISMATCH"]);
    if(r.linkHits<1) return probeHtml(res,409,"NEED_LINK",["ERROR=VISIT_STAGE_2_FIRST"]);
    if(!valuePattern.test(value)) return probeHtml(res,400,"INVALID_VALUE",["ERROR=INVALID_VALUE"]);
    if(r.value!==null && r.value!==value)
      return probeHtml(res,409,"VALUE_CONFLICT",["ERROR=CASE_VALUE_ALREADY_SET"]);
    r.value=value;
    r.submitHits++;
    const result=origin+"/probe/result?case="+id+"&fetch="+r.submitHits;
    return probeHtml(res,200,"Stage 3: Delivered",[
      "STATE=VALUE_DELIVERED_TO_SERVER","CASE="+id,
      "SERVER_RECEIPT=HIDDEN_UNTIL_RESULT_PAGE",
      "FINAL_STEP=OPEN_THE_RESULT_PAGE_LINK_BELOW_AND_COPY_ALL_THREE_PROOFS"
    ],result,"OPEN RESULT PAGE: GET SERVER RECEIPTS");
  }
  if(path==="/probe/result") {
    if(r.value===null) return probeHtml(res,409,"NOT_DELIVERED",["STATE=NOT_DELIVERED"]);
    r.resultHits++;
    return probeHtml(res,200,"Closed Loop Confirmed",[
      "STATE=CLOSED_LOOP_COMPLETE","CASE="+id,
      "READ_PROOF="+r.readProof,
      "LINK_PROOF="+r.linkProof,
      "DELIVERY_RECEIPT="+r.submitProof,
      "SERVER_RESULT="+r.value.split("").reverse().join("").toUpperCase(),
      "VERIFIED_ON_SERVER=STAGES_1_2_3"
    ]);
  }
  if(path==="/probe/audit")
    return probeHtml(res,200,"Read-only server-side audit",[
      "CASE="+id,"STAGE_1_READ_HITS="+r.startHits,
      "STAGE_2_LINK_HITS="+r.linkHits,
      "STAGE_3_SUBMIT_HITS="+r.submitHits,
      "FINAL_RESULT_HITS="+r.resultHits,
      "VALUE_RECEIVED="+(r.value!==null?"YES":"NO"),
      "RECEIPT_DISCLOSED_BY_AUDIT=NO"
    ]);
  return probeHtml(res,404,"UNKNOWN_PROBE_ROUTE",["ERROR=NOT_FOUND"]);
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
      if(path==="/robots.txt") return text(res, 200, "User-agent: *\nAllow: /probe/\nDisallow: /submit\nDisallow: /status\nDisallow: /result\nDisallow: /audit");
      if(path==="/probe" || path.startsWith("/probe/")) return handleProbe(req,res,url,path,"https://"+host);
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
