import fs from "node:fs";
import net from "node:net";
import { chromium } from "playwright";
import { recordGap } from "./pcg_web_gap_ledger.mjs";
import { createSemanticOperations } from "./pcg_web_semantic_ops.mjs";
import { createPrivateFileBroker } from "./pcg_web_file_broker.mjs";
import { createConversationIdentity } from "./pcg_web_identity.mjs";
import { createMaterialSendBridge } from "./pcg_web_send.mjs";
import { createMaterialUploadIngress } from "./pcg_web_material_ingress.mjs";
import { TELEGRAM_SELECTORS } from "./pcg_web_selectors.mjs";

const START_URL = "https://web.telegram.org/k/";
const ALLOWED_ORIGIN = "https://web.telegram.org";
const MY_TELEGRAM_ORIGIN = "https://my.telegram.org";
const MY_TELEGRAM_AUTH_URL = "https://my.telegram.org/auth";
const MY_TELEGRAM_APPS_URL = "https://my.telegram.org/apps";
const MY_TELEGRAM_CODE_FILE = "/run/pcg/mytelegram-code";
const MY_TELEGRAM_API_FILE = "/run/pcg/mytelegram-api.json";
const PROFILE_DIR = process.env.PCG_WEB_PROFILE_DIR || "/profile";
const SOCKET_PATH = process.env.PCG_WEB_SOCKET || "/run/pcg/web.sock";
const HANDLE_REGISTRY_FILE = process.env.PCG_WEB_HANDLE_REGISTRY || (PROFILE_DIR + "/.pcg-conversation-handles.json");
const DOWNLOAD_BROKER_ROOT = process.env.PCG_WEB_DOWNLOAD_BROKER || "/run/pcg/downloads";
const SEND_CORRELATION_FILE = process.env.PCG_WEB_SEND_CORRELATION || (PROFILE_DIR + "/.pcg-send-correlation.json");
const MATERIAL_FILE_ROOT = process.env.PCG_WEB_MATERIAL_FILE_ROOT || "/run/pcg/material-files";
const MATERIAL_UPLOAD_SOCKET_PATH = process.env.PCG_WEB_MATERIAL_UPLOAD_SOCKET || "/run/pcg/ingress/material-upload.sock";

function fail(code, message = code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function safeUrl(page) {
  try {
    const u = new URL(page.url());
    return { origin: u.origin, pathname: u.pathname };
  } catch {
    return { origin: null, pathname: null };
  }
}

async function visible(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;
  return await loc.isVisible().catch(() => false);
}

async function detectPhase(page) {
  if (!page || page.isClosed()) return "BROWSER_CLOSED";
  const { origin } = safeUrl(page);
  if (origin !== ALLOWED_ORIGIN) return "NOT_TELEGRAM";
  if (await visible(page, TELEGRAM_SELECTORS.ready)) return "READY";
  if (await visible(page, TELEGRAM_SELECTORS.phone)) return "PHONE_NUMBER";
  if (await visible(page, TELEGRAM_SELECTORS.code)) return "CODE";
  if (await visible(page, TELEGRAM_SELECTORS.password)) return "PASSWORD";
  if ((await page.locator(TELEGRAM_SELECTORS.authRoot).count()) > 0) return "AUTH_OTHER";
  return "LOADING";
}

async function waitForKnownPhase(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let phase = await detectPhase(page);
  while (Date.now() < deadline) {
    if (!["LOADING", "NOT_TELEGRAM"].includes(phase)) return phase;
    await page.waitForTimeout(250);
    phase = await detectPhase(page);
  }
  return phase;
}

let context;
let page;
let myPage;

const semantic = createSemanticOperations({
  getPage: () => page,
  detectPhase: () => detectPhase(page),
  handleRegistryFile: HANDLE_REGISTRY_FILE,
  downloadBrokerRoot: DOWNLOAD_BROKER_ROOT,
  getMaterialSend: () => materialSend,
});

const ingressDownloadBroker = createPrivateFileBroker(DOWNLOAD_BROKER_ROOT, {
  maxFileBytes: 32 * 1024 * 1024,
});

const materialSend = createMaterialSendBridge({
  identity: createConversationIdentity(HANDLE_REGISTRY_FILE),
  correlationFile: SEND_CORRELATION_FILE,
  materialFileRoot: MATERIAL_FILE_ROOT,
});

const materialUploadIngress = createMaterialUploadIngress({
  socketPath: MATERIAL_UPLOAD_SOCKET_PATH,
  materialFileRoot: MATERIAL_FILE_ROOT,
});

async function launch() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    chromiumSandbox: false,
    locale: "en-US",
    viewport: { width: 1365, height: 900 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(45000);
}

async function ensureTelegramPage() {
  if (!page || page.isClosed()) {
    page = context.pages().find((p) => !p.isClosed()) || await context.newPage();
  }
  const current = safeUrl(page);
  if (current.origin !== ALLOWED_ORIGIN || !current.pathname.startsWith("/k")) {
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  } else {
    await page.bringToFront();
  }
  return await waitForKnownPhase(page, 20000);
}

async function maybeSwitchFromQrToPhone() {
  let phase = await detectPhase(page);
  if (phase === "PHONE_NUMBER") return phase;
  if (phase !== "AUTH_OTHER") return phase;

  const button = page.getByRole("button", { name: /phone/i }).first();
  if ((await button.count()) > 0 && await button.isVisible().catch(() => false)) {
    await button.click();
    phase = await waitForKnownPhase(page, 10000);
  }
  return phase;
}

function boundedSecret(value, label, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.includes("\0")) {
    fail("INVALID_" + label.toUpperCase());
  }
  return value;
}

async function safeStatus(phaseOverride = null) {
  const phase = phaseOverride || await detectPhase(page);
  const u = safeUrl(page);
  return {
    ok: true,
    phase,
    origin: u.origin,
    pathname: u.pathname,
    logged_in: phase === "READY",
  };
}

async function opOpen() {
  const phase = await ensureTelegramPage();
  return safeStatus(phase);
}

async function opPhone(value) {
  const phone = boundedSecret(value, "phone", 64);
  await ensureTelegramPage();
  let phase = await maybeSwitchFromQrToPhone();
  if (phase !== "PHONE_NUMBER") {
    return { ...(await safeStatus(phase)), ok: false, error: "PHONE_FORM_NOT_AVAILABLE" };
  }

  const input = page.locator(TELEGRAM_SELECTORS.phone).first();
  await input.fill(phone);
  await input.press("Enter");

  const deadline = Date.now() + 30000;
  do {
    await page.waitForTimeout(300);
    phase = await detectPhase(page);
    if (phase !== "PHONE_NUMBER" && phase !== "LOADING") break;
  } while (Date.now() < deadline);

  if (phase === "PHONE_NUMBER") {
    return { ...(await safeStatus(phase)), ok: false, error: "PHONE_SUBMISSION_NOT_ADVANCED" };
  }
  return safeStatus(phase);
}

async function opCode(value) {
  const code = boundedSecret(value, "code", 32).replace(/\s+/g, "");
  let phase = await ensureTelegramPage();
  if (phase !== "CODE") {
    return { ...(await safeStatus(phase)), ok: false, error: "CODE_FORM_NOT_AVAILABLE" };
  }

  const input = page.locator(TELEGRAM_SELECTORS.code).first();
  await input.fill(code);

  const deadline = Date.now() + 30000;
  do {
    await page.waitForTimeout(300);
    phase = await detectPhase(page);
    if (phase !== "CODE" && phase !== "LOADING") break;
  } while (Date.now() < deadline);

  if (phase === "CODE") {
    return { ...(await safeStatus(phase)), ok: false, error: "CODE_REJECTED_OR_NOT_ADVANCED" };
  }
  return safeStatus(phase);
}

async function opPassword(value) {
  const password = boundedSecret(value, "password", 512);
  let phase = await ensureTelegramPage();
  if (phase !== "PASSWORD") {
    return { ...(await safeStatus(phase)), ok: false, error: "PASSWORD_FORM_NOT_AVAILABLE" };
  }

  const input = page.locator(TELEGRAM_SELECTORS.password).first();
  await input.fill(password);
  await input.press("Enter");

  const deadline = Date.now() + 30000;
  do {
    await page.waitForTimeout(300);
    phase = await detectPhase(page);
    if (phase !== "PASSWORD" && phase !== "LOADING") break;
  } while (Date.now() < deadline);

  if (phase === "PASSWORD") {
    return { ...(await safeStatus(phase)), ok: false, error: "PASSWORD_REJECTED_OR_NOT_ADVANCED" };
  }
  return safeStatus(phase);
}

function safeMyUrl() {
  if (!myPage || myPage.isClosed()) return { origin: null, pathname: null };
  try {
    const u = new URL(myPage.url());
    return { origin: u.origin, pathname: u.pathname };
  } catch {
    return { origin: null, pathname: null };
  }
}

async function ensureMyTelegramPage(path = "/auth") {
  if (!myPage || myPage.isClosed()) {
    myPage = context.pages().find((p) => {
      try { return new URL(p.url()).origin === MY_TELEGRAM_ORIGIN; } catch { return false; }
    }) || await context.newPage();
    myPage.setDefaultTimeout(10000);
    myPage.setDefaultNavigationTimeout(45000);
  }
  const u = safeMyUrl();
  const target = MY_TELEGRAM_ORIGIN + path;
  if (u.origin !== MY_TELEGRAM_ORIGIN || u.pathname !== path) {
    await myPage.goto(target, { waitUntil: "domcontentloaded" });
  } else {
    await myPage.bringToFront();
  }
  return myPage;
}

async function detectMyTelegramPhase() {
  if (!myPage || myPage.isClosed()) return "MY_BROWSER_CLOSED";
  const u = safeMyUrl();
  if (u.origin !== MY_TELEGRAM_ORIGIN) return "MY_NOT_TELEGRAM";
  if (await visible(myPage, "#app_id") || await visible(myPage, "#app_hash")) return "APP_READY";
  if (await visible(myPage, 'input[name="app_title"]')) return "APP_FORM";
  const bodyText = await myPage.locator("body").innerText().catch(() => "");
  if (/Your Phone Number/i.test(bodyText) && /Next/i.test(bodyText)) return "PHONE_NUMBER";
  if (/Confirmation code/i.test(bodyText) && /Sign In/i.test(bodyText)) return "CONFIRMATION_CODE";
  if (u.pathname.startsWith("/apps")) return "APPS_UNKNOWN";
  return "MY_UNKNOWN";
}

async function opMyTelegramStart(value) {
  const phone = boundedSecret(value, "phone", 64);
  const tgPhase = await ensureTelegramPage();
  if (tgPhase !== "READY") {
    return { ok: false, phase: tgPhase, error: "TELEGRAM_SESSION_NOT_READY" };
  }

  await ensureMyTelegramPage("/auth");
  let phase = await detectMyTelegramPhase();
  if (phase === "CONFIRMATION_CODE") return { ok: true, phase };
  if (phase !== "PHONE_NUMBER") {
    await myPage.goto(MY_TELEGRAM_AUTH_URL, { waitUntil: "domcontentloaded" });
    phase = await detectMyTelegramPhase();
  }

  const phoneInput = myPage.locator('input:not([type="checkbox"]):visible').first();
  if ((await phoneInput.count()) === 0) {
    return { ok: false, phase, error: "MY_PHONE_INPUT_NOT_FOUND" };
  }
  await phoneInput.fill(phone);

  const next = myPage.getByRole("button", { name: /next/i }).first();
  if ((await next.count()) > 0 && await next.isVisible().catch(() => false)) {
    await next.click();
  } else {
    await phoneInput.press("Enter");
  }

  const deadline = Date.now() + 30000;
  do {
    await myPage.waitForTimeout(300);
    phase = await detectMyTelegramPhase();
    if (phase === "CONFIRMATION_CODE") return { ok: true, phase };
  } while (Date.now() < deadline);

  return { ok: false, phase, error: "MY_CODE_REQUEST_NOT_CONFIRMED" };
}

async function opCaptureMyTelegramCode() {
  const phase = await ensureTelegramPage();
  if (phase !== "READY") {
    return { ok: false, phase, error: "TELEGRAM_SESSION_NOT_READY" };
  }

  await page.goto("https://web.telegram.org/k/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);

  let row = page.locator(TELEGRAM_SELECTORS.chatRow + '[data-peer-id="777000"]').first();
  if ((await row.count()) === 0) {
    row = page.locator(TELEGRAM_SELECTORS.chatRow).filter({ hasText: /^Telegram/i }).first();
  }
  if ((await row.count()) === 0) {
    const search = page.locator(TELEGRAM_SELECTORS.search).first();
    if ((await search.count()) > 0 && await search.isVisible().catch(() => false)) {
      await search.fill("Telegram");
      await page.waitForTimeout(1800);
      row = page.locator(TELEGRAM_SELECTORS.chatRow + '[data-peer-id="777000"]').first();
      if ((await row.count()) === 0) {
        row = page.locator(TELEGRAM_SELECTORS.chatRow).filter({ hasText: /^Telegram/i }).first();
      }
    }
  }
  if ((await row.count()) === 0) {
    return { ok: false, phase: "CODE_ROW_NOT_FOUND", error: "MY_TELEGRAM_CODE_NOT_FOUND" };
  }

  await row.click();
  await page.waitForTimeout(2200);

  const bubbles = page.locator(".bubbles-inner .bubble");
  const bubbleCount = await bubbles.count();
  if (bubbleCount < 1) {
    return { ok: false, phase: "CODE_CHAT_EMPTY", error: "MY_TELEGRAM_CODE_NOT_FOUND" };
  }

  const scanCount = Math.min(6, bubbleCount);
  const sources = [];
  for (let idx = bubbleCount - scanCount; idx < bubbleCount; idx++) {
    const bubble = bubbles.nth(idx);
    const values = await bubble.evaluate((el) => {
      const out = [];
      const push = (v) => {
        if (typeof v === "string" && v) out.push(v);
      };
      push(el.textContent || "");
      push(el.innerText || "");
      push(el.outerHTML || "");
      const nodes = [el, ...el.querySelectorAll("*")];
      for (const node of nodes) {
        push(node.textContent || "");
        for (const attr of ["aria-label", "title", "data-text", "data-content", "data-value", "value", "style"]) {
          push(node.getAttribute?.(attr) || "");
        }
        try { push(getComputedStyle(node, "::before").content || ""); } catch {}
        try { push(getComputedStyle(node, "::after").content || ""); } catch {}
      }
      return out;
    });
    sources.push(...values);
  }

  let code = "";
  for (let i = sources.length - 1; i >= 0; i--) {
    const source = sources[i];
    const marker = source.match(/(?:Login|Confirmation) code:\s*([\s\S]*?)(?:Do not give|If you didn't request|$)/i);
    if (marker) {
      const digits = marker[1].replace(/\D/g, "");
      if (digits.length >= 5) {
        code = digits.slice(0, 5);
        break;
      }
    }
  }

  if (!code) {
    const combined = sources.join("\n");
    const all = [...combined.matchAll(/\b(\d{5})\b/g)].map((m) => m[1]);
    if (all.length) code = all.at(-1);
  }

  if (!/^\d{5}$/.test(code)) {
    return { ok: false, phase: "CODE_BUBBLE_FOUND_NO_DIGITS", error: "MY_TELEGRAM_CODE_NOT_FOUND" };
  }

  fs.writeFileSync(MY_TELEGRAM_CODE_FILE, code + "\n", { mode: 0o600 });
  fs.chmodSync(MY_TELEGRAM_CODE_FILE, 0o600);
  return { ok: true, phase: "CODE_CAPTURED" };
}

async function captureApiCredentialsIfPresent() {
  if (!myPage || myPage.isClosed()) return false;
  const idLoc = myPage.locator("#app_id").first();
  const hashLoc = myPage.locator("#app_hash").first();
  if ((await idLoc.count()) === 0 || (await hashLoc.count()) === 0) return false;
  const apiId = (await idLoc.innerText()).trim();
  const apiHash = (await hashLoc.innerText()).trim();
  if (!/^\d+$/.test(apiId) || !/^[0-9a-fA-F]{16,128}$/.test(apiHash)) return false;
  fs.writeFileSync(MY_TELEGRAM_API_FILE, JSON.stringify({ api_id: Number(apiId), api_hash: apiHash }) + "\n", { mode: 0o600 });
  fs.chmodSync(MY_TELEGRAM_API_FILE, 0o600);
  return true;
}

async function opMyTelegramSignIn() {
  if (!fs.existsSync(MY_TELEGRAM_CODE_FILE)) {
    return { ok: false, phase: "CODE_MISSING", error: "MY_TELEGRAM_CODE_FILE_MISSING" };
  }
  const code = fs.readFileSync(MY_TELEGRAM_CODE_FILE, "utf8").trim();
  if (!/^\d{5}$/.test(code)) {
    return { ok: false, phase: "CODE_INVALID", error: "MY_TELEGRAM_CODE_INVALID" };
  }

  await ensureMyTelegramPage("/auth");
  let phase = await detectMyTelegramPhase();
  if (phase !== "CONFIRMATION_CODE") {
    return { ok: false, phase, error: "MY_CONFIRMATION_FORM_NOT_AVAILABLE" };
  }

  const inputs = myPage.locator('input:not([type="checkbox"]):visible');
  const count = await inputs.count();
  if (count < 1) {
    return { ok: false, phase, error: "MY_CONFIRMATION_INPUT_NOT_FOUND" };
  }
  const codeInput = inputs.nth(count - 1);
  await codeInput.fill(code);

  const signIn = myPage.getByRole("button", { name: /sign in/i }).first();
  if ((await signIn.count()) > 0 && await signIn.isVisible().catch(() => false)) {
    await signIn.click();
  } else {
    await codeInput.press("Enter");
  }

  await myPage.waitForTimeout(1500);
  await myPage.goto(MY_TELEGRAM_APPS_URL, { waitUntil: "domcontentloaded" });
  phase = await detectMyTelegramPhase();
  const captured = await captureApiCredentialsIfPresent();
  try { fs.unlinkSync(MY_TELEGRAM_CODE_FILE); } catch {}
  if (captured) return { ok: true, phase: "APP_READY" };
  if (phase === "APP_FORM") return { ok: true, phase };
  return { ok: false, phase, error: "MY_APPS_PAGE_UNEXPECTED" };
}

async function opMyTelegramCreateApp() {
  await ensureMyTelegramPage("/apps");
  let phase = await detectMyTelegramPhase();
  if (await captureApiCredentialsIfPresent()) {
    return { ok: true, phase: "APP_READY" };
  }
  if (phase !== "APP_FORM") {
    return { ok: false, phase, error: "MY_APP_FORM_NOT_AVAILABLE" };
  }

  const appTitle = "Capability Fabric PCG";
  const appShort = "cfpcgvps20260921";
  await myPage.locator('input[name="app_title"]').fill(appTitle);
  await myPage.locator('input[name="app_shortname"]').fill(appShort);
  const urlInput = myPage.locator('input[name="app_url"]').first();
  if ((await urlInput.count()) > 0) await urlInput.fill("https://example.com");
  const desc = myPage.locator('textarea[name="app_desc"], input[name="app_desc"]').first();
  if ((await desc.count()) > 0) await desc.fill("Personal communications gateway testing");

  const platformRadio = myPage.locator('input[name="app_platform"][value="desktop"]').first();
  if ((await platformRadio.count()) > 0) {
    await platformRadio.check().catch(async () => { await platformRadio.click(); });
  } else {
    const platformSelect = myPage.locator('select[name="app_platform"]').first();
    if ((await platformSelect.count()) > 0) await platformSelect.selectOption("desktop");
  }

  const submit = myPage.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if ((await submit.count()) === 0) {
    return { ok: false, phase, error: "MY_APP_SUBMIT_NOT_FOUND" };
  }
  await submit.click();
  await myPage.waitForTimeout(2500);

  if (await captureApiCredentialsIfPresent()) {
    return { ok: true, phase: "APP_READY" };
  }

  phase = await detectMyTelegramPhase();
  const bodyText = await myPage.locator("body").innerText().catch(() => "");
  if (/\bERROR\b/i.test(bodyText)) {
    return { ok: false, phase: "CREATE_ERROR", error: "MY_APP_CREATE_ERROR" };
  }
  return { ok: false, phase, error: "MY_APP_CREATE_NOT_CONFIRMED" };
}

async function opMyTelegramScreenshot() {
  await ensureMyTelegramPage(safeMyUrl().pathname || "/auth");
  const screenshotPath = "/run/pcg/mytelegram-ui.png";
  await myPage.screenshot({ path: screenshotPath, type: "png", fullPage: false });
  fs.chmodSync(screenshotPath, 0o600);
  const phase = await detectMyTelegramPhase();
  return { ok: true, phase };
}

async function opScreenshot() {
  const phase = await ensureTelegramPage();
  if (phase !== "READY") {
    return { ...(await safeStatus(phase)), ok: false, error: "SESSION_NOT_READY" };
  }
  const screenshotPath = "/run/pcg/telegram-web-ui.png";
  await page.screenshot({ path: screenshotPath, type: "png", fullPage: false });
  fs.chmodSync(screenshotPath, 0o600);
  return safeStatus("READY");
}


async function dispatch(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) fail("INVALID_REQUEST");
  switch (req.op) {
    case "health":
      return safeStatus();
    case "semantic.list":
      return { ok: true, capabilities: semantic.capabilities() };
    case "semantic.invoke":
      return semantic.invoke(req);
    case "qualify.conversation_list_no_read":
      return semantic.qualifyConversationListNoRead();
    case "qualify.conversation_search_no_read":
      return semantic.qualifyConversationSearchNoRead();
    case "qualify.conversation_structure":
      return semantic.qualifyConversationStructure();
    case "qualify.topic_retrieval_no_read":
      return semantic.qualifyTopicRetrievalNoRead();
    case "qualify.message_retrieval_no_read":
      return semantic.qualifyMessageRetrievalNoRead();
    case "qualify.conversation_mark_read":
      return semantic.qualifyConversationMarkRead();
    case "qualify.message_open_media":
      return semantic.qualifyMessageOpenMedia();
    case "qualify.attachment_download":
      return semantic.qualifyAttachmentDownload();
    case "qualify.composer_foundation":
      return semantic.qualifyComposerFoundation();
    case "material.self_target":
      return materialSend.selfTarget(page);
    case "material.target.check":
      return materialSend.checkTarget(page, req.conversation_handle);
    case "material.reply_target.check":
      return materialSend.checkReplyTarget(page, req.conversation_handle, req.source_message_handle);
    case "material.self_reply_target":
      return materialSend.selfReplyTarget(page);
    case "material.send_text.dispatch":
      return materialSend.dispatchText(page, req);
    case "material.send_text.observe":
      return materialSend.observeText(page, req);
    case "material.send_photo_album.dispatch":
      return materialSend.dispatchPhotoAlbum(page, req);
    case "material.send_photo_album.observe":
      return materialSend.observePhotoAlbum(page, req);
    case "material.send_attachment.dispatch":
      return materialSend.dispatchAttachment(page, req);
    case "material.send_attachment.observe":
      return materialSend.observeAttachment(page, req);
    case "material.reply_attachment.dispatch":
      return materialSend.dispatchReplyAttachment(page, req);
    case "material.reply_attachment.observe":
      return materialSend.observeReplyAttachment(page, req);
    case "material.self_relay_target":
      return materialSend.selfRelayTarget(page, req.expected_text);
    case "material.relay_target.check":
      return materialSend.checkRelayTarget(
        page,
        req.source_conversation_handle,
        req.source_message_handle,
        req.conversation_handle,
      );
    case "material.relay_text.dispatch":
      return materialSend.dispatchRelayText(page, req);
    case "material.relay_text.observe":
      return materialSend.observeRelayText(page, req);
    case "material.self_forward_target":
      return materialSend.selfForwardTarget(page, req.expected_text);
    case "material.forward_target.check":
      return materialSend.checkForwardTarget(
        page,
        req.source_conversation_handle,
        req.source_message_handle,
        req.conversation_handle,
      );
    case "material.forward_native.dispatch":
      return materialSend.dispatchForwardNative(page, req);
    case "material.forward_native.observe":
      return materialSend.observeForwardNative(page, req);
    case "material.self_delete_target":
      return materialSend.selfDeleteTarget(page, req.expected_text);
    case "material.delete_target.check":
      return materialSend.checkDeleteTarget(page, req.conversation_handle, req.message_handle, req.scope);
    case "material.delete_message.dispatch":
      return materialSend.dispatchDeleteMessage(page, req);
    case "material.delete_message.observe":
      return materialSend.observeDeleteMessage(page, req);
    case "material.self_edit_target":
      return materialSend.selfEditTarget(page);
    case "material.edit_target.check":
      return materialSend.checkEditTarget(page, req.conversation_handle, req.message_handle);
    case "material.edit_text.dispatch":
      return materialSend.dispatchEditText(page, req);
    case "material.edit_text.observe":
      return materialSend.observeEditText(page, req);
    case "material.reply_text.dispatch":
      return materialSend.dispatchReplyText(page, req);
    case "material.reply_text.observe":
      return materialSend.observeReplyText(page, req);
    case "open":
      return opOpen();
    case "login.phone":
      return opPhone(req.value);
    case "login.code":
      return opCode(req.value);
    case "login.password":
      return opPassword(req.value);
    case "screenshot":
      return opScreenshot();
    case "mytelegram.start":
      return opMyTelegramStart(req.value);
    case "mytelegram.capture_code":
      return opCaptureMyTelegramCode();
    case "mytelegram.signin":
      return opMyTelegramSignIn();
    case "mytelegram.create_app":
      return opMyTelegramCreateApp();
    case "mytelegram.screenshot":
      return opMyTelegramScreenshot();
    default:
      fail("UNSUPPORTED_OPERATION");
  }
}

function sanitizeError(err) {
  const code = typeof err?.code === "string" ? err.code : "BROWSER_OPERATION_FAILED";
  return { ok: false, error: code, phase: "UNKNOWN" };
}

const INGRESS_DIR = "/run/pcg/ingress";
const INGRESS_SOCKET_PATH = INGRESS_DIR + "/web.sock";

// Ingress admission is derived from the semantic capability registry itself:
// whatever the semantic layer declares as implemented is reachable from the
// connector, with the data-use purpose implied by its declared classes.
// Adding a capability therefore exposes it without editing a second list; a
// capability that is not ready must say so in the registry (support NOT_*).
// Irreversible effects are gated per call by their own confirmation argument,
// not by this admission step.
// Admission and data-use purpose are both derived from the capability
// registry, which the semantic layer owns. See pcg_web_semantic_ops.purposeFor.
function ingressPurposeFor(operation) {
  return semantic.purposeFor(operation);
}

// A refused ingress call must teach the caller what does exist, so a wrong
// operation name costs one cheap corrective retry instead of a dead end.
function ingressRefusal(operation, guidance) {
  const admitted = semantic.capabilities()
    .filter((entry) => typeof entry.support === "string" && entry.support.startsWith("IMPLEMENTED"))
    .map((entry) => entry.operation);
  const wanted = new Set(String(operation || "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
  const nearest = admitted
    .map((name) => {
      const tokens = new Set(name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean));
      let score = 0;
      for (const token of wanted) if (tokens.has(token)) score += 1;
      return { name, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((entry) => entry.name);
  recordGap({
    surface: "ingress",
    operation,
    code: "INGRESS_OPERATION_FORBIDDEN",
    state: "REFUSED",
    detail: guidance,
  });
  return {
    ok: false,
    error: "INGRESS_OPERATION_FORBIDDEN",
    guidance_detail: guidance,
    requested_operation: typeof operation === "string" ? operation : null,
    nearest_operations: nearest,
    available_operations: admitted,
  };
}

async function dispatchIngress(req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    fail("INGRESS_OPERATION_FORBIDDEN");
  }
  if (req.op === "health") {
    return safeStatus();
  }
  if (req.op === "semantic.list") {
    return { ok: true, capabilities: semantic.capabilities() };
  }
  if (req.op === "file.export") {
    const handle = typeof req.file_handle === "string" ? req.file_handle.trim().toLowerCase() : "";
    if (!/^file:[0-9a-f]{64}$/.test(handle)) fail("INVALID_FILE_HANDLE");
    const maxBytes = req.max_bytes === undefined ? ingressDownloadBroker.maxFileBytes : req.max_bytes;
    return { ok: true, ...ingressDownloadBroker.exportBase64(handle, { maxBytes }) };
  }
  if (req.op !== "semantic.invoke" || typeof req.operation !== "string" || !req.operation) {
    return ingressRefusal(req.operation, "Ingress accepts op \"health\", op \"semantic.list\", or op \"semantic.invoke\" together with a non-empty operation name.");
  }
  const args = req.args && typeof req.args === "object" && !Array.isArray(req.args) ? req.args : {};
  const purpose = ingressPurposeFor(req.operation);
  if (!purpose) {
    return ingressRefusal(req.operation, "That operation is not admitted: it is absent from the capability registry or its declared support is not IMPLEMENTED. Retry once with one of the nearest listed operations.");
  }
  const result = await semantic.invoke({ ...req, purpose, args });
  // Single choke point: anything the caller will read as "this did not work"
  // is recorded here, with argument names only, never argument values.
  const state = result?.outcome || result?.state;
  if (state && state !== "ACHIEVED") {
    recordGap({
      surface: "semantic",
      operation: req.operation,
      code: result?.error || result?.error_code || state,
      state,
      detail: result?.observation?.guidance_detail || result?.guidance_detail || null,
      args,
    });
  }
  return result;
}

async function startServer() {
  try { fs.unlinkSync(SOCKET_PATH); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024 * 1024) {
        socket.end(JSON.stringify({ ok: false, error: "REQUEST_TOO_LARGE" }) + "\n");
        return;
      }
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      buf = "";
      try {
        const req = JSON.parse(line);
        const out = await dispatch(req);
        socket.end(JSON.stringify(out) + "\n");
      } catch (err) {
        socket.end(JSON.stringify(sanitizeError(err)) + "\n");
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o660);
  });

  fs.mkdirSync(INGRESS_DIR, { recursive: true, mode: 0o770 });
  fs.chmodSync(INGRESS_DIR, 0o770);
  try { fs.unlinkSync(INGRESS_SOCKET_PATH); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  const ingressServer = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) {
        socket.end(JSON.stringify({ ok: false, error: "REQUEST_TOO_LARGE" }) + "\n");
        return;
      }
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      buf = "";
      try {
        const out = await dispatchIngress(JSON.parse(line));
        socket.end(JSON.stringify(out) + "\n");
      } catch (err) {
        socket.end(JSON.stringify(sanitizeError(err)) + "\n");
      }
    });
  });
  ingressServer.listen(INGRESS_SOCKET_PATH, () => fs.chmodSync(INGRESS_SOCKET_PATH, 0o660));
  await materialUploadIngress.start();

  const shutdown = async () => {
    try { server.close(); } catch {}
    try { ingressServer.close(); } catch {}
    try { await materialUploadIngress.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    try { fs.unlinkSync(INGRESS_SOCKET_PATH); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

await launch();
await ensureTelegramPage().catch(() => {});
await startServer();
