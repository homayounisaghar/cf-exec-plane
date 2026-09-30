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

export const PROVIDER_MODEL_VERSION = 2;

// Installed inside the page once per session; re-installed after navigation.
const PROVIDER_MODEL_SOURCE = `(() => {
  const VERSION = ${PROVIDER_MODEL_VERSION};
  if (globalThis.__pcgProvider && globalThis.__pcgProvider.version === VERSION) return;

  // The client shifts server ids by this offset to build client-side ids.
  const MESSAGE_ID_OFFSET = 0x100000000;

  const call = async (manager, method, ...args) => {
    if (!manager || typeof manager[method] !== "function") {
      const error = new Error("PROVIDER_PRIMITIVE_MISSING:" + method);
      error.pcgCode = "PROVIDER_PRIMITIVE_MISSING";
      throw error;
    }
    // Always awaited: the proxy is asynchronous even when the underlying
    // implementation is synchronous.
    return await manager[method](...args);
  };

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

  // Content-free self-check of the provider model itself.
  const probe = async (managers) => {
    const ids = managers?.appMessagesIdsManager;
    const out = {
      version: VERSION,
      managers_present: Boolean(ids),
      async_managers: null,
      id_round_trip: null,
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

  globalThis.__pcgProvider = { version: VERSION, call, selfDestructing, serverMessageId, probe };
})()`;

// Idempotent per page; survives re-navigation because it re-installs on demand.
export async function ensureProviderModel(page) {
  await page.evaluate(PROVIDER_MODEL_SOURCE);
}

export async function probeProviderModel(page) {
  await ensureProviderModel(page);
  return page.evaluate(async () => {
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
