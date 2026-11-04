const marker = "DEXA_VERCEL_DYNAMIC_OK";
const cors = {
  "Access-Control-Allow-Origin": "https://homayounisaghar.github.io",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
  "Cache-Control": "no-store, max-age=0",
  "X-Content-Type-Options": "nosniff"
};

export default {
  fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {status:204,headers:cors});
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", {status:405,headers:cors});
    }

    const encoder = new TextEncoder();
    let timer;
    let finished = false;
    const stream = new ReadableStream({
      start(controller) {
        let step = 0;
        timer = setInterval(() => {
          if (finished) return;
          step += 1;
          controller.enqueue(encoder.encode("event: tick\ndata: " + JSON.stringify({
            marker, step, utc:new Date().toISOString()
          }) + "\n\n"));
          if (step === 3) {
            finished = true;
            clearInterval(timer);
            controller.close();
          }
        }, 600);
        request.signal?.addEventListener("abort", () => {
          if (!finished) {
            finished = true;
            clearInterval(timer);
            try { controller.close(); } catch {}
          }
        }, {once:true});
      },
      cancel() {
        finished = true;
        clearInterval(timer);
      }
    });
    return new Response(stream, {
      status:200,
      headers:{
        ...cors,
        "Content-Type":"text/event-stream; charset=utf-8",
        "Connection":"keep-alive",
        "X-Accel-Buffering":"no"
      }
    });
  }
};
