import fs from "node:fs";
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8787;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8788;
const BUILD_ID = "onshape-gateway-r16-screenshot-mcp-prefix";
const TOKEN_FILE = "/run/secrets/mcp-token";

const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("MCP token file is missing or invalid.");
const mcpPath = `/mcp/${token}`;

const server = http.createServer((req, res) => {
  res.setHeader("x-cf-gateway-build-id", BUILD_ID);

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cf-onshape-single ok");
    return;
  }

  const pathname = String(req.url || "").split("?", 1)[0];
  const isScreenshotDownload = /^\/mcp\/screenshot\/[0-9a-f]{64}$/.test(pathname);
  const isTelegramFileDownload = /^\/mcp\/telegram-file\/[0-9a-f]{64}$/.test(pathname);
  const isTelegramMaterialUpload = /^\/mcp\/upload\/[0-9a-f]{64}$/.test(pathname);
  if (pathname === mcpPath) {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Use POST" }));
      return;
    }
  } else if (isTelegramMaterialUpload) {
    if (req.method !== "PUT") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Use PUT" }));
      return;
    }
  } else if (isScreenshotDownload || isTelegramFileDownload) {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Use GET" }));
      return;
    }
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const headers = { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` };
  delete headers.connection;
  delete headers["proxy-connection"];

  const upstream = http.request({
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    responseHeaders["x-cf-gateway-build-id"] = BUILD_ID;
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Onshape backend unavailable" }));
  });

  req.pipe(upstream);
});

server.listen(PORT, HOST, () => {
  console.log(`cf-onshape-gateway listening on ${HOST}:${PORT}`);
});