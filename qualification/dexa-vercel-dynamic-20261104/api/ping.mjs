import { randomUUID } from "node:crypto";

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
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", {status:405,headers:cors});
    }
    return Response.json({
      ok: true,
      marker,
      requestId: randomUUID(),
      utc: new Date().toISOString()
    }, {status:200,headers:cors});
  }
};
