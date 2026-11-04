const MARKER = "DEXA_CLOUDFLARE_DYNAMIC_OK";
const ALLOWED_ORIGIN = "https://homayounisaghar.github.io";
const EGRESS_URL = "https://dexa-probe.65-109-215-241.sslip.io/";

const html = String.raw`<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>آزمایش رایگان ارتباط پویای دکسا — کلودفلر</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#16283b}
body{background:#f4f7fc;min-height:100svh;margin:0;box-sizing:border-box;display:grid;place-items:center;padding:18px}
main{background:#fff;width:min(450px,100%);box-sizing:border-box;border:1px solid #dde8f0;border-radius:23px;padding:24px;box-shadow:0 5px 20px #1927350c}
h1{margin:0;line-height:1.7;font-size:1.35rem}
p,small{line-height:1.95}
code{display:block;text-align:center;direction:ltr;background:#eaf4ee;padding:13px;border-radius:12px;font-weight:bold;font-size:.9rem;overflow-wrap:anywhere}
button{display:block;width:100%;padding:13px;border:0;border-radius:12px;background:#195fcc;color:white;font-weight:700;font-size:1rem;margin:11px 0}
button:nth-of-type(2){background:#20775d}
button:nth-of-type(3){background:#495b75}
output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#eef3fb;padding:15px;min-height:65px;border-radius:12px;line-height:1.8;margin-top:13px}
small{display:block;color:#657386;margin-top:14px}
</style></head>
<body><main>
<h1>آزمایش ارتباط دکسا روی کلودفلر</h1>
<p>این نسخه فقط آزمایش شبکه است و به موتور واقعی یا اطلاعات خصوصی دکسا وصل نیست.</p>
<code>DEXA_CLOUDFLARE_DYNAMIC_OK</code>
<button id="ping">دریافت پاسخ تازهٔ سرور</button>
<button id="stream">دریافت سه پیام زنده</button>
<button id="egress">آزمایش مسیر عمومی تا هتزنر</button>
<output id="result">آمادهٔ آزمایش.</output>
<small>فیلترشکن را خاموش کن؛ هیچ رمز یا دادهٔ خصوصی ارسال نکن.</small>
</main><script>
const output=document.getElementById("result");
const prefix="DEXA_CLOUDFLARE_DYNAMIC_OK";
document.getElementById("ping").onclick=async()=>{output.textContent="در حال دریافت...";
try{let r=await fetch("/api/ping?x="+Date.now(),{cache:"no-store"});
let j=await r.json();output.textContent=r.ok&&j.marker===prefix?
"موفق: پاسخ تازه با شناسهٔ "+j.id+" دریافت شد.":"پاسخ نامعتبر بود."}
catch(e){output.textContent="ارتباط با سرور برقرار نشد."}};
document.getElementById("stream").onclick=()=>{output.textContent="در حال دریافت پیام‌های زنده...";let n=0,finished=false;
const es=new EventSource("/api/events?x="+Date.now());
const timer=setTimeout(()=>done("زمان آزمایش تمام شد؛ پیام‌ها: "+n),14000);
function done(msg){if(finished)return;finished=true;clearTimeout(timer);es.close();output.textContent=msg}
es.addEventListener("tick",e=>{try{const d=JSON.parse(e.data);if(d.marker!==prefix)return;
n++;output.textContent="پیام زندهٔ "+n+" دریافت شد.";if(n===3)done("موفق: سه پیام زنده بدون فیلترشکن دریافت شدند.")}
catch(e){done("پیام زنده نامعتبر بود.")}});
es.onerror=()=>done("ارتباط زنده کامل نشد؛ پیام‌ها: "+n);
};
document.getElementById("egress").onclick=async()=>{output.textContent="در حال بررسی مسیر هتزنر...";
try{const r=await fetch("/api/hetzner-public-check?x="+Date.now(),{cache:"no-store"});
const j=await r.json();
output.textContent=j.marker===prefix&&j.reachable?
"موفق: کلودفلر پاسخ عمومی هتزنر را دریافت کرد.":
"مسیر هتزنر تأیید نشد؛ وضعیت: "+(j.status===null?"بدون پاسخ":j.status);}
catch(e){output.textContent="آزمایش مسیر هتزنر ناموفق بود."}};
</script></body></html>`;

function hdr(type) {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
export default {
 async fetch(request) {
   const url=new URL(request.url);
   const path=url.pathname;
   if(request.method==="OPTIONS" && path.startsWith("/api/")) return new Response(null,{status:204,headers:hdr("text/plain")});
   if(request.method!=="GET") return new Response("Method not allowed",{status:405,headers:hdr("text/plain")});
   if(path==="/") return new Response(html,{status:200,headers:{...hdr("text/html; charset=utf-8"),"Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}});
   if(path==="/healthz"||path==="/api/ping") return Response.json({ok:true,marker:MARKER,id:crypto.randomUUID(),utc:new Date().toISOString()},{headers:hdr("application/json; charset=utf-8")});
   if(path==="/api/events") {
      let t, step=0, ended=false;
      const stream=new ReadableStream({
        start(controller) {
          t=setInterval(()=>{
            if(ended)return;
            step++;
            controller.enqueue(new TextEncoder().encode("event: tick\ndata: "+JSON.stringify({marker:MARKER,step,utc:new Date().toISOString()})+"\n\n"));
            if(step===3){ended=true;clearInterval(t);controller.close();}
          },500);
          request.signal?.addEventListener("abort",()=>{if(!ended){ended=true;clearInterval(t);try{controller.close()}catch(e){}}},{once:true});
        },
        cancel(){ended=true;clearInterval(t);}
      });
      return new Response(stream,{status:200,headers:{...hdr("text/event-stream; charset=utf-8"),"X-Accel-Buffering":"no"}});
   }
   if(path==="/api/hetzner-public-check") {
      try {
        const r=await fetch(EGRESS_URL,{method:"GET",signal:AbortSignal.timeout(7000),redirect:"error",headers:{"Accept":"text/plain"}});
        const body=(await r.text()).slice(0,256);
        return Response.json({marker:MARKER,reachable:r.status===200&&body.includes("DEXA_ALT_ORIGIN_TEST_OK"),status:r.status},{headers:hdr("application/json; charset=utf-8")});
      } catch(e) {
        return Response.json({marker:MARKER,reachable:false,status:null},{headers:hdr("application/json; charset=utf-8")});
      }
   }
   return new Response("Not found",{status:404,headers:hdr("text/plain; charset=utf-8")});
 }
};