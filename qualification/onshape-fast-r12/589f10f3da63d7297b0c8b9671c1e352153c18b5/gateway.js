import crypto from "node:crypto";

const BASE_URL = "https://raw.githubusercontent.com/homayounisaghar/cf-exec-plane/main/qualification/onshape-fast-r12/482e02726adf3a6a69687a4b165515c0596854ae/gateway.js";
const BASE_SHA256 = "1b41efb503f082d80d5da4b26bdd698aa4d23923a722de84a7b9fd32cf8a3b6c";

const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error("BASE_GATEWAY_FETCH_FAILED_" + response.status);
const source = await response.text();
const digest = crypto.createHash("sha256").update(source).digest("hex");
if (digest !== BASE_SHA256) throw new Error("BASE_GATEWAY_DIGEST_MISMATCH");
await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
