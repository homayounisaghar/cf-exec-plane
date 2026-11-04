import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGIN = "https://homayounisaghar.github.io";
const MARKER = "DEXA_NORTHFLANK_DYNAMIC_OK";

const html = String.raw`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>آزمایش پویای دکسا روی نورث‌فلنک</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
body{background:#f7f9fc;color:#152334;min-height:100svh;display:grid;place-items:center;margin:0;padding:20px;box-sizing:border-box}
main{width:min(430px,100%);background:white;border:1px solid #e2e7f0;border-radius:24px;padding:25px;box-sizing:border-box}
h1{margin-top:0}p{line-height:2}
code{direction:ltr;display:block;background:#f0f5f1;padding:14px;border-radius:10px;text-align:center;overflow-wrap:anywhere}
button{width:100%;margin:10px 0;padding:14px;border:0;border-radius:11px;background:#1869d6;color:white;font-size:1rem;font-weight:bold}
button:last-of-type{background:#236757}
output{display:block;white-space:pre-wrap;background:#f1f5fe;border-radius:10px;padding:14px;margin-top:12px;min-height:45px;line-height:1.8}
small{color:#5f6b7a;line-height:2;display:block;margin-top:20px}
</style></head>
<body><main><h1>آزمایش ارتباط پویای دکسا</h1>
<p>این برنامه روی سرور نورث‌فلنک اجرا می‌شود و به موتور اصلی دکسا وصل نیست.</p>
<code>DEXA_NORTHFLANK_DYNAMIC_OK</code>
<button id="ping">درخواست پاسخ تازه از سرور</button>
<button id="stream">آزمایش دریافت زندهٔ نتیجه</button>
<output id="result">هنوز آزمایش نشده است.</output>
<small>فقط برای آزمایش شبکه است. هیچ حساب، رمز یا اطلاعات شخصی دریافت نمی‌شود.</small>
</main><script>
const out=document.getElementById("result");
document.getElementById("ping").onclick=async()=>{
 out.textContent="در حال دریافت پاسخ...";
 try{const r=await fetch("./api/ping",{cache:"no-store"});const j=await r.json();
 out.textContent=r.ok&&j.marker==="DEXA_NORTHFLANK_DYNAMIC_OK"?
 "موفق: پاسخ جدید از سرور دریافت شد. شناسه: "+j.requestId:
 "پاسخ غیرمنتظره از سرور.";}catch(e){out.textContent="دریافت پاسخ ناموفق بود.";}
};
document.getElementById("stream").onclick=()=>{
 out.textContent="در حال دریافت پیام‌های زنده...";
 const es=new EventSource("./api/events");let count=0;
 const timeout=setTimeout(()=>{es.close();if(count<3)out.textContent+="\nپخش زنده کامل نشد.";},12000);
 es.addEventListener("tick",e=>{try{const j=JSON.parse(e.data);
 if(j.marker==="DEXA_NORTHFLANK_DYNAMIC_OK"){count++;out.textContent+="\nپیام زندهٔ "+count+" دریافت شد.";
 if(count===3){clearTimeout(timeout);es.close();out.textContent+="\nموفق: دریافت سه پیام زنده تأیید شد.";}}
 }catch(err){out.textContent+="\nپاسخ نامعتبر.";es.close();clearTimeout(timeout);}});
 es.onerror=()=>{clearTimeout(timeout);es.close();if(count<3)out.textContent+="\nارتباط زنده قطع شد.";};
};
</script></body></html>`;

function headers(type) {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
const app = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { res.writeHead(400);res.end("Bad request");return; }
  if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
    res.writeHead(204, headers("text/plain")); res.end(); return;
  }
  if (req.method !== "GET") { res.writeHead(405);res.end("Method not allowed");return; }
  if (pathname === "/") {
    res.writeHead(200, {
      ...headers("text/html; charset=utf-8"),
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(html); return;
  }
  if (pathname === "/api/hetzner-public-check") {
    (async () => {
      try {
        const r = await fetch("https://dexa-probe.65-109-215-241.sslip.io/", {
          signal: AbortSignal.timeout(6000),
          headers: { Accept: "text/plain" }
        });
        const body = (await r.text()).slice(0,200);
        res.writeHead(200, headers("application/json; charset=utf-8"));
        res.end(JSON.stringify({ marker: MARKER, reachable: r.status === 200 && body.includes("DEXA_ALT_ORIGIN_TEST_OK"), status: r.status }));
      } catch {
        res.writeHead(200, headers("application/json; charset=utf-8"));
        res.end(JSON.stringify({ marker: MARKER, reachable: false, status: null }));
      }
    })();
    return;
  }
  if (pathname === "/healthz" || pathname === "/api/ping") {
    res.writeHead(200, headers("application/json; charset=utf-8"));
    res.end(JSON.stringify({ok:true, marker:MARKER, requestId:randomUUID(), utc:new Date().toISOString()})); return;
  }
  if (pathname === "/api/events") {
    res.writeHead(200, {...headers("text/event-stream; charset=utf-8"), "Connection":"keep-alive","X-Accel-Buffering":"no"});
    if (res.flushHeaders) res.flushHeaders();
    let step=0;
    const timer=setInterval(()=>{
      if(res.destroyed){clearInterval(timer);return;}
      step++;
      res.write("event: tick\ndata: "+JSON.stringify({marker:MARKER,step,utc:new Date().toISOString()})+"\n\n");
      if(step===3){clearInterval(timer);res.end();}
    },500);
    res.on("close",()=>clearInterval(timer)); return;
  }
  res.writeHead(404,headers("text/plain; charset=utf-8"));res.end("Not found");
});
app.listen(PORT, HOST, () => console.log("Harmless dynamic pilot listening on "+HOST+":"+PORT));
