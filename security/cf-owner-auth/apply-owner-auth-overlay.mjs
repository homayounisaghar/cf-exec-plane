import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function one(source, needle, replacement, label) {
  const i = source.indexOf(needle);
  if (i < 0 || source.indexOf(needle, i + needle.length) >= 0) throw new Error(`overlay marker invalid: ${label}`);
  return source.slice(0, i) + replacement + source.slice(i + needle.length);
}
export function applyOwnerAuthOverlay({ sourceDir, destDir, sequence, releaseId }) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destDir, { recursive: true });
  for (const name of ["owner-auth.mjs", "owner-auth.test.mjs"]) fs.copyFileSync(path.join(here, name), path.join(destDir, name));

  const serverFile = path.join(destDir, "server.js");
  let server = fs.readFileSync(serverFile, "utf8");
  if (!server.includes("createOwnerAuthGate")) {
    const target = 'const target = "/tmp/app/server.base.mjs";';
    const patch = String.raw`const ownerAuthImportNeedle = 'import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";';
if (!source.includes(ownerAuthImportNeedle)) throw new Error("OWNER_AUTH_IMPORT_MARKER_MISSING");
source = source.replace(ownerAuthImportNeedle, ownerAuthImportNeedle + '\nimport { createOwnerAuthGate, registerOwnerAuthTools } from "./owner-auth.mjs";');
const ownerAuthTokenNeedle = 'const MCP_TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();\nif (!/^[A-Za-z0-9_-]{32,}$/.test(MCP_TOKEN)) throw new Error("MCP token file is missing or invalid.");';
if (!source.includes(ownerAuthTokenNeedle)) throw new Error("OWNER_AUTH_TOKEN_MARKER_MISSING");
source = source.replace(ownerAuthTokenNeedle, ownerAuthTokenNeedle + '\nconst ownerAuth = createOwnerAuthGate({ stateDir: AGENT_STATE_DIR + "/owner-auth", buildId: BUILD_ID });');
if (!source.includes(implementationReplacement)) throw new Error("OWNER_AUTH_SERVER_MARKER_MISSING");
source = source.replace(implementationReplacement, implementationReplacement + '\n  registerOwnerAuthTools(server, z, ownerAuth, safeTool);');
const ownerAuthJsonNeedle = 'app.use(express.json({ limit: "5mb" }));';
if (!source.includes(ownerAuthJsonNeedle)) throw new Error("OWNER_AUTH_MIDDLEWARE_MARKER_MISSING");
source = source.replace(ownerAuthJsonNeedle, ownerAuthJsonNeedle + '\napp.use((req, res, next) => {\n  const decision = ownerAuth.authorizeToolCall(req.body);\n  if (decision.allowed) { next(); return; }\n  res.status(200).json(ownerAuth.deniedRpc(req.body?.id, decision));\n});');
`;
    server = one(server, target, `${patch}\n${target}`, "server target");
    fs.writeFileSync(serverFile, server);
  }

  const composeFile = path.join(destDir, "compose.yaml");
  let compose = fs.readFileSync(composeFile, "utf8");
  if (!compose.includes("/release/owner-auth.mjs")) {
    compose = one(compose, " /tmp/app/ &&", " /release/owner-auth.mjs /tmp/app/ &&", "compose copy destination");
    fs.writeFileSync(composeFile, compose);
  }

  const closureFile = path.join(destDir, "release-closure.json");
  const closure = JSON.parse(fs.readFileSync(closureFile, "utf8"));
  closure.build_id = releaseId;
  closure.files = [...new Set([...(closure.files || []), "owner-auth.mjs", "owner-auth.test.mjs"])].sort();
  fs.writeFileSync(closureFile, JSON.stringify(closure, null, 2) + "\n");

  const manifestFile = path.join(destDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.sequence = sequence;
  manifest.release_id = releaseId;
  const names = [...new Set([...Object.keys(manifest.files || {}), "owner-auth.mjs", "owner-auth.test.mjs"])].sort();
  manifest.files = Object.fromEntries(names.map(name => [name, digest(path.join(destDir, name))]));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  return { sequence, releaseId, destDir };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDir, destDir, sequence, releaseId] = process.argv.slice(2);
  console.log(JSON.stringify(applyOwnerAuthOverlay({ sourceDir: path.resolve(sourceDir), destDir: path.resolve(destDir), sequence: Number(sequence), releaseId })));
}
