import crypto from "node:crypto";

const BASE_URL = "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/qualification/onshape-fast-r12/482e02726adf3a6a69687a4b165515c0596854ae/gateway.js";
const BASE_SHA256 = "1b41efb503f082d80d5da4b26bdd698aa4d23923a722de84a7b9fd32cf8a3b6c";
const ICON_BASE64 = "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";

const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error("BASE_GATEWAY_FETCH_FAILED_" + response.status);
let source = await response.text();
const digest = crypto.createHash("sha256").update(source).digest("hex");
if (digest !== BASE_SHA256) throw new Error("BASE_GATEWAY_DIGEST_MISMATCH");

const mcpPathNeedle = 'const mcpPath = `/mcp/${token}`;';
if (!source.includes(mcpPathNeedle)) throw new Error("BASE_GATEWAY_MCP_PATH_MARKER_MISSING");
source = source.replace(
  mcpPathNeedle,
  mcpPathNeedle + '\nconst cfServerIcon = Buffer.from(' + JSON.stringify(ICON_BASE64) + ', "base64");',
);

const routeNeedle = '  if (req.method === "GET" && req.url === "/") {';
if (!source.includes(routeNeedle)) throw new Error("BASE_GATEWAY_ROOT_ROUTE_MARKER_MISSING");
source = source.replace(
  routeNeedle,
  '  if (req.method === "GET" && req.url === "/mcp/cf-server-icon.png") {\n' +
  '    res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });\n' +
  '    res.end(cfServerIcon);\n' +
  '    return;\n' +
  '  }\n\n' +
  routeNeedle,
);

await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
