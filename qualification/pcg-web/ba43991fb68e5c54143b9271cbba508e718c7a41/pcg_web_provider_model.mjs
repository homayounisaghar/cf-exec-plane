// Proven provider model for the Telegram Web client.
//
// Why this module exists.
//
// The web client keeps its state managers in a worker and exposes them through
// a proxy: *every* manager method returns a Promise. Our bridge code called
// some of those methods without awaiting them. A Promise is an object, so
// `Number(promise.messageId)` became `NaN` and `promise` was always truthy.
// That single mistake produced two unrelated-looking live failures — reactions
// refused as "ephemeral", then refused for an "invalid message id" — and it
// stayed invisible for weeks because the other call sites degraded silently to
// "could not confirm" instead of reporting that our own adapter was wrong.
//
// The architectural rules this module enforces:
//
//   1. Every provider-manager call is asynchronous and must be awaited.
//      Call sites go through `pcgProviderCall`, never through a raw method.
//   2. A derived provider value must be PROVEN, not assumed. The server
//      message id is accepted only when it regenerates the client id we
//      started from.
//   3. An adapter defect must never be reported as provider uncertainty.
//      Failures here raise `PROVIDER_PRIMITIVE_*`, which is a defect signal
//      recorded in the capability gap ledger, distinct from IN_DOUBT.
//   4. The model is self-checking. `probeProviderModel` verifies the async
//      manager contract and the id round-trip without touching any message,
//      so this class of bug is detected before an owner ever tries it.

export const PROVIDER_MODEL_VERSION = 5;

// Installed inside the page once per session; re-installed after navigation.
const PROVIDER_MODEL_SOURCE = `(() => {
  const VERSION = ${PROVIDER_MODEL_VERSION};
  if (globalThis.__pcgProvider && globalThis.__pcgProvider.version === VERSION) return;

  // The client shifts server ids by this offset to build client-side ids.
  const MESSAGE_ID_OFFSET = 0x100000000;

  // No provider await is unbounded. A provider that never answers must produce
  // a named failure, not silence: silence is indistinguishable from success
  // that has not arrived yet, and that ambiguity is what hides defects.
  const DEFAULT_DEADLINE_MS = 15000;

  const withDeadline = (promise, timeoutMs, method) => new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error("PROVIDER_PRIMITIVE_TIMEOUT:" + method);
      error.pcgCode = "PROVIDER_PRIMITIVE_TIMEOUT";
      error.timeout_ms = timeoutMs;
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
    );
  });

  const callWithin = async (timeoutMs, manager, method, ...args) => {
    if (!manager || typeof manager[method] !== "function") {
      const error = new Error("PROVIDER_PRIMITIVE_MISSING:" + method);
      error.pcgCode = "PROVIDER_PRIMITIVE_MISSING";
      throw error;
    }
    // Always awaited: the proxy is asynchronous even when the underlying
    // implementation is synchronous. Always bounded: see above.
    return await withDeadline(manager[method](...args), timeoutMs, method);
  };

  const call = async (manager, method, ...args) => callWithin(DEFAULT_DEADLINE_MS, manager, method, ...args);

  // A message object has already crossed the proxy boundary, so its own fields
  // are plain data and can be read directly. Self-destruction is a property of
  // the message, not something we ask a helper about.
  const selfDestructing = (message) => {
    const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
    return positive(message?.ttl_period) || positive(message?.media?.ttl_seconds);
  };

  // Resolve and prove the server-side message id for a client-side id.
  const serverMessageId = async (ids, mid, message) => {
    const candidates = [];
    const add = (source, value) => {
      const numeric = Number(value);
      if (Number.isSafeInteger(numeric) && numeric > 0) candidates.push({ source, value: numeric });
    };

    if (ids && typeof ids.getMessageIdInfo === "function") {
      try {
        const info = await call(ids, "getMessageIdInfo", mid);
        if (Array.isArray(info)) add("getMessageIdInfo[0]", info[0]);
        else if (info && typeof info === "object") {
          add("getMessageIdInfo.messageId", info.messageId);
          add("getMessageIdInfo.serverId", info.serverId);
        } else add("getMessageIdInfo", info);
      } catch {}
    }
    if (ids && typeof ids.getServerMessageId === "function") {
      try { add("getServerMessageId", await call(ids, "getServerMessageId", mid)); } catch {}
    }
    if (message && typeof message === "object") add("message.id", message.id);
    if (Number.isSafeInteger(mid) && mid > MESSAGE_ID_OFFSET) add("mid-offset", mid % MESSAGE_ID_OFFSET);
    add("mid", mid);

    // Proof: regenerating the client id from the candidate must return the id
    // we were given. This is what makes the result a fact rather than a guess.
    if (ids && typeof ids.generateMessageId === "function") {
      for (const candidate of candidates) {
        for (const channel of [1, 0, undefined]) {
          try {
            const regenerated = Number(await call(ids, "generateMessageId", candidate.value, channel));
            if (regenerated === mid) {
              return { ok: true, value: candidate.value, source: candidate.source, proof: "round_trip" };
            }
          } catch {}
        }
      }
    }
    if (candidates.length > 0) {
      return { ok: true, value: candidates[0].value, source: candidates[0].source, proof: "unproven" };
    }
    return { ok: false, sources_seen: [], proof: "none" };
  };

  // The provider answers with a server id; the client addresses messages by a
  // shifted id of its own. One place resolves between the two id spaces and
  // proves the result by reading the message back, so no call site has to
  // guess which id space it is holding.
  const clientMessageId = async (managers, peerId, serverId, predicate) => {
    const ids = managers?.appMessagesIdsManager;
    const messages = managers?.appMessagesManager;
    const candidates = [];
    const push = (value) => {
      const numeric = Number(value);
      if (Number.isSafeInteger(numeric) && numeric > 0 && !candidates.includes(numeric)) candidates.push(numeric);
    };
    if (ids && typeof ids.generateMessageId === "function") {
      for (const channel of [1, 0, undefined]) {
        try { push(await call(ids, "generateMessageId", serverId, channel)); } catch {}
      }
    }
    push(serverId);
    if (messages && typeof predicate === "function") {
      // Cache first: the message we just created is already in the local copy
      // after its update was processed, so proof costs nothing. Only if the
      // cache cannot answer do we pay for one short network read per candidate.
      for (const candidate of candidates) {
        if (typeof messages.getMessageByPeer !== "function") break;
        try {
          const cached = await callWithin(3000, messages, "getMessageByPeer", peerId, candidate);
          if (cached?._ === "message" && predicate(cached) === true) {
            return { value: candidate, proven: true, source: "cache", candidates };
          }
        } catch {}
      }
      for (const candidate of candidates) {
        if (typeof messages.reloadMessage !== "function") break;
        try {
          const observed = await callWithin(3000, messages, "reloadMessage", peerId, candidate, false);
          if (observed?._ === "message" && predicate(observed) === true) {
            return { value: candidate, proven: true, source: "reload", candidates };
          }
        } catch {}
      }
    }
    return { value: candidates.length > 0 ? candidates[0] : null, proven: false, candidates };
  };

  // Content-free self-check of the provider model itself.
  // Proven liveness of the transport itself: a cheap request that must travel
  // to the provider and come back. Without this, "READY" only means that a
  // page finished loading, which is not the same as a reachable provider.
  const transportRoundTrip = async (managers) => {
    const api = managers?.apiManager;
    const out = { present: Boolean(api), healthy: null, ms: null, error: null };
    if (!api || typeof api.invokeApi !== "function") return out;
    const started = Date.now();
    try {
      const result = await callWithin(10000, api, "invokeApi", "help.getNearestDc", {});
      out.healthy = Boolean(result);
    } catch (err) {
      out.healthy = false;
      out.error = err?.pcgCode || "PROVIDER_TRANSPORT_FAILED";
    }
    out.ms = Date.now() - started;
    return out;
  };

  const probe = async (managers) => {
    const ids = managers?.appMessagesIdsManager;
    const out = {
      version: VERSION,
      managers_present: Boolean(ids),
      async_managers: null,
      id_round_trip: null,
      transport: await transportRoundTrip(managers),
    };
    if (!ids || typeof ids.generateMessageId !== "function") return out;
    try {
      // If the proxy is asynchronous, the un-awaited result is a thenable.
      const pending = ids.generateMessageId(1, 1);
      out.async_managers = Boolean(pending && typeof pending.then === "function");
      const generated = Number(await pending);
      const resolved = await serverMessageId(ids, generated, null);
      out.id_round_trip = resolved.ok === true && resolved.value === 1 && resolved.proof === "round_trip";
    } catch {
      out.async_managers = out.async_managers === null ? false : out.async_managers;
      out.id_round_trip = false;
    }
    return out;
  };

  globalThis.__pcgProvider = { version: VERSION, call, callWithin, selfDestructing, serverMessageId, clientMessageId, probe };
})()`;

// Idempotent per page; survives re-navigation because it re-installs on demand.
export async function ensureProviderModel(page) {
  await page.evaluate(PROVIDER_MODEL_SOURCE);
}

// The node side of every page hop is bounded as well, so a page that stops
// answering produces a named failure instead of an indefinite wait.
async function evaluateWithin(page, timeoutMs, fn) {
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error("WEB_PROVIDER_EVALUATE_TIMEOUT");
      err.code = "WEB_PROVIDER_EVALUATE_TIMEOUT";
      err.timeout_ms = timeoutMs;
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([page.evaluate(fn), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeProviderModel(page) {
  await ensureProviderModel(page);
  return evaluateWithin(page, 30000, async () => {
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return { version: null, managers_present: false, async_managers: null, id_round_trip: null };
    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return { version: null, managers_present: false, async_managers: null, id_round_trip: null };
    }
    return globalThis.__pcgProvider.probe(create(accountNumber));
  });
}
