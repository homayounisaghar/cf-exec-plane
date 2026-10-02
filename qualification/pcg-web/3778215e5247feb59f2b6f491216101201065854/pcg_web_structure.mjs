function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function safeProviderRef(providerRef) {
  if (typeof providerRef !== "string" || !/^-?[1-9][0-9]*$/.test(providerRef)) {
    fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
  }
  const peerId = Number(providerRef);
  if (!Number.isSafeInteger(peerId) || peerId === 0) fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
  return peerId;
}

function boundedLimit(value, max = 100) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail("WEBK_STRUCTURE_LIMIT_INVALID");
  return value;
}

function boundedOffset(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100000) fail("WEBK_STRUCTURE_OFFSET_INVALID");
  return value;
}

async function invoke(page, command) {
  const result = await page.evaluate(async (command) => {
    const failResult = (error) => ({ ok: false, error });
    const create = globalThis.createProxiedManagersForAccount;
    if (typeof create !== "function") return failResult("WEBK_MANAGER_PROXY_UNAVAILABLE");

    const rawAccount = new URL(location.href).searchParams.get("account") || "1";
    const accountNumber = Number.parseInt(rawAccount, 10);
    if (!Number.isInteger(accountNumber) || accountNumber < 1 || accountNumber > 4) {
      return failResult("WEBK_ACCOUNT_INVALID");
    }

    const managers = create(accountNumber);
    const dialogs = managers?.dialogsStorage;
    const peers = managers?.appPeersManager;
    const users = managers?.appUsersManager;
    const api = managers?.apiManager;
    const messages = managers?.appMessagesManager;
    if (!dialogs || !peers || !users || !api) return failResult("WEBK_STRUCTURE_MANAGER_UNAVAILABLE");

    const titleForPeer = (peer, selfUserId = null) => {
      if (!peer || typeof peer !== "object") return null;
      if (peer._ === "user") {
        if (peer.pFlags?.self === true || (selfUserId !== null && String(peer.id) === String(selfUserId))) {
          return "Saved Messages";
        }
        const title = [peer.first_name, peer.last_name]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" ")
          .trim();
        if (title) return title.slice(0, 256);
        if (typeof peer.username === "string" && peer.username) return ("@" + peer.username).slice(0, 256);
        return "Deleted Account";
      }
      if ((peer._ === "chat" || peer._ === "channel" || peer._ === "chatForbidden" || peer._ === "channelForbidden")
          && typeof peer.title === "string" && peer.title.trim()) {
        return peer.title.trim().slice(0, 256);
      }
      return null;
    };

    const kindForPeer = (peer) => {
      if (!peer || typeof peer !== "object") return null;
      if (peer._ === "user") return peer.pFlags?.bot === true ? "bot" : "user";
      if (peer._ === "chat" || peer._ === "chatForbidden") return "group";
      if (peer._ === "channel" || peer._ === "channelForbidden") {
        if (peer.pFlags?.megagroup === true || peer.pFlags?.gigagroup === true) return "supergroup";
        if (peer.pFlags?.broadcast === true) return "channel";
        return "channel";
      }
      return null;
    };

    const peerFromPromo = (promo, peerId) => {
      const userId = promo?.peer?._ === "peerUser" ? String(promo.peer.user_id) : null;
      const chatId = promo?.peer?._ === "peerChat" ? String(promo.peer.chat_id)
        : promo?.peer?._ === "peerChannel" ? String(promo.peer.channel_id) : null;
      if (userId !== null) {
        return (promo.users || []).find((item) => item?._ === "user" && String(item.id) === userId) || null;
      }
      if (chatId !== null) {
        return (promo.chats || []).find((item) =>
          (item?._ === "chat" || item?._ === "channel" || item?._ === "chatForbidden" || item?._ === "channelForbidden")
          && String(item.id) === chatId
        ) || null;
      }
      return null;
    };

    let self = null;
    try { self = await users.getSelf(); } catch {}
    const selfUserId = self?.id ?? null;

    if (command.type === "conversation_structure") {
      for (const [manager, methods] of [
        [dialogs, ["getDialogs", "isDialogPinned"]],
        [peers, ["getPeer", "getPeerId", "isForum", "isBotforum"]],
        [api, ["invokeApi"]],
      ]) {
        if (methods.some((name) => typeof manager?.[name] !== "function")) {
          return failResult("WEBK_STRUCTURE_PRIMITIVE_UNAVAILABLE");
        }
      }

      let value;
      try {
        value = await dialogs.getDialogs({
          query: "",
          offsetIndex: 0,
          limit: command.limit,
          filterId: 0,
        });
      } catch {
        return failResult("WEBK_DIALOG_STRUCTURE_FETCH_FAILED");
      }

      const regular = [];
      for (const dialog of Array.isArray(value?.dialogs) ? value.dialogs : []) {
        let peerId = Number(dialog?.peerId);
        if (!Number.isSafeInteger(peerId) || peerId === 0) {
          try { peerId = Number(await peers.getPeerId(dialog?.peer)); } catch {}
        }
        if (!Number.isSafeInteger(peerId) || peerId === 0) continue;

        let peer = null;
        try { peer = await peers.getPeer(peerId); } catch {}
        const title = titleForPeer(peer, selfUserId);
        if (!title) continue;

        let pinned = false;
        let isForum = false;
        let isBotforum = false;
        try { pinned = await dialogs.isDialogPinned(peerId, 0) === true; }
        catch { pinned = dialog?.pFlags?.pinned === true; }
        try { isForum = await peers.isForum(peerId) === true; } catch {}
        try { isBotforum = await peers.isBotforum(peerId) === true; } catch {}

        const unreadCount = Number.isSafeInteger(Number(dialog?.unread_count))
          ? Math.max(0, Number(dialog.unread_count))
          : 0;
        const unreadMark = dialog?.pFlags?.unread_mark === true;
        regular.push({
          provider_ref: String(peerId),
          name: title,
          peer_kind: kindForPeer(peer),
          pinned,
          sponsored: false,
          proxy_sponsor: false,
          sponsor_kind: null,
          is_forum: isForum || isBotforum,
          forum_kind: isBotforum ? "botforum" : (isForum ? "forum" : null),
          list_section: pinned ? "pinned" : "normal",
          unread_count: unreadCount,
          unread_mark: unreadMark,
          has_unread: unreadCount > 0 || unreadMark,
        });
      }

      let promoEntry = null;
      let promoFetchState = "EMPTY";
      try {
        const promo = await api.invokeApi("help.getPromoData", {});
        if (promo?._ === "help.promoData" && promo.peer) {
          const promoPeerId = Number(await peers.getPeerId(promo.peer));
          if (Number.isSafeInteger(promoPeerId) && promoPeerId !== 0) {
            const rawPeer = peerFromPromo(promo, promoPeerId);
            let title = titleForPeer(rawPeer, selfUserId);
            if (!title) {
              try { title = titleForPeer(await peers.getPeer(promoPeerId), selfUserId); } catch {}
            }
            if (title) {
              const proxy = promo.pFlags?.proxy === true;
              let isForum = false;
              let isBotforum = false;
              try { isForum = await peers.isForum(promoPeerId) === true; } catch {}
              try { isBotforum = await peers.isBotforum(promoPeerId) === true; } catch {}
              let promoPeer = rawPeer;
              if (!promoPeer) { try { promoPeer = await peers.getPeer(promoPeerId); } catch {} }
              promoEntry = {
                provider_ref: String(promoPeerId),
                name: title,
                peer_kind: kindForPeer(promoPeer),
                pinned: false,
                sponsored: true,
                proxy_sponsor: proxy,
                sponsor_kind: proxy ? "proxy" : "telegram_promo",
                is_forum: isForum || isBotforum,
                forum_kind: isBotforum ? "botforum" : (isForum ? "forum" : null),
                list_section: proxy ? "proxy_sponsor" : "sponsored",
                unread_count: 0,
                unread_mark: false,
                has_unread: false,
              };
              promoFetchState = proxy ? "PROXY_SPONSOR" : "SPONSORED";
            }
          }
        }
      } catch {
        promoFetchState = "UNAVAILABLE";
      }

      const seen = new Set();
      const ordered = [];
      if (promoEntry) {
        ordered.push(promoEntry);
        seen.add(promoEntry.provider_ref);
      }
      for (const item of regular.filter((item) => item.pinned)) {
        if (!seen.has(item.provider_ref)) {
          ordered.push(item);
          seen.add(item.provider_ref);
        }
      }
      for (const item of regular.filter((item) => !item.pinned)) {
        if (!seen.has(item.provider_ref)) {
          ordered.push(item);
          seen.add(item.provider_ref);
        }
      }

      return {
        ok: true,
        entries: ordered.slice(0, command.limit),
        promo_fetch_state: promoFetchState,
      };
    }

    if (command.type === "conversation_pin_set") {
      if (!messages || typeof messages.setDialogPin !== "function" || typeof dialogs.isDialogPinned !== "function") {
        return failResult("WEBK_CONVERSATION_PIN_PRIMITIVE_UNAVAILABLE");
      }
      if (typeof command.pinned !== "boolean") return failResult("WEBK_CONVERSATION_PIN_STATE_INVALID");

      let before;
      try {
        before = await dialogs.isDialogPinned(command.peerId, 0) === true;
      } catch {
        return failResult("WEBK_CONVERSATION_PIN_PRECHECK_FAILED");
      }

      if (before === command.pinned) {
        return {
          ok: true,
          outcome: "ACHIEVED",
          before,
          after: before,
          effect_attempted: false,
          effect_invocation_acknowledged: false,
          provider_confirmed: true,
          error: null,
        };
      }

      let providerError = null;
      let invocationAcknowledged = false;
      try {
        await messages.setDialogPin({
          peerId: command.peerId,
          pinned: command.pinned,
          folderId: 0,
        });
        invocationAcknowledged = true;
      } catch (err) {
        providerError = typeof err?.type === "string" && err.type
          ? err.type
          : (typeof err?.message === "string" && err.message ? err.message : "WEBK_CONVERSATION_PIN_CALL_FAILED");
      }

      let after = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try { after = await dialogs.isDialogPinned(command.peerId, 0) === true; } catch {}
        if (after === command.pinned) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      if (after === command.pinned) {
        return {
          ok: true,
          outcome: "ACHIEVED",
          before,
          after,
          effect_attempted: true,
          effect_invocation_acknowledged: invocationAcknowledged,
          provider_confirmed: true,
          error: null,
        };
      }

      const explicitFailure = providerError === "PINNED_DIALOGS_TOO_MUCH"
        || providerError === "PINNED_TOO_MUCH"
        || providerError === "PINNED_DIALOGS_CHANGED";
      return {
        ok: true,
        outcome: explicitFailure ? "FAILED" : "IN_DOUBT",
        before,
        after,
        effect_attempted: true,
        effect_invocation_acknowledged: invocationAcknowledged,
        provider_confirmed: false,
        error: explicitFailure ? providerError : "WEBK_CONVERSATION_PIN_IN_DOUBT",
      };
    }

    if (command.type === "topic_list") {
      for (const [manager, methods] of [
        [dialogs, ["getDialogs"]],
        [peers, ["isForum", "isBotforum"]],
      ]) {
        if (methods.some((name) => typeof manager?.[name] !== "function")) {
          return failResult("WEBK_TOPIC_PRIMITIVE_UNAVAILABLE");
        }
      }

      let isForum = false;
      let isBotforum = false;
      try { isForum = await peers.isForum(command.peerId) === true; } catch {}
      try { isBotforum = await peers.isBotforum(command.peerId) === true; } catch {}
      if (!isForum && !isBotforum) return failResult("WEBK_TOPIC_TARGET_NOT_SUPPORTED");

      let value;
      try {
        value = await dialogs.getDialogs({
          query: "",
          offsetIndex: command.offsetIndex,
          limit: command.limit,
          filterId: command.peerId,
        });
      } catch {
        return failResult("WEBK_TOPIC_LIST_FETCH_FAILED");
      }

      const topics = [];
      for (const topic of Array.isArray(value?.dialogs) ? value.dialogs : []) {
        const topicId = Number(topic?.id);
        if (!Number.isSafeInteger(topicId) || topicId <= 0) continue;
        if (topic?.pFlags?.hidden === true) continue;
        const title = typeof topic.title === "string" && topic.title.trim()
          ? topic.title.trim().slice(0, 256)
          : "Untitled topic";
        topics.push({
          topic_id: topicId,
          title,
          pinned: topic.pFlags?.pinned === true,
          closed: topic.pFlags?.closed === true,
          unread_count: Number.isSafeInteger(Number(topic.unread_count)) ? Number(topic.unread_count) : 0,
        });
      }

      return {
        ok: true,
        forum_kind: isBotforum ? "botforum" : "forum",
        topics,
        next_offset_index: topics.length === command.limit ? command.offsetIndex + topics.length : null,
      };
    }

    if (command.type === "topic_snapshot") {
      if (typeof dialogs.getForumTopicOrReload !== "function") return failResult("WEBK_TOPIC_SNAPSHOT_PRIMITIVE_UNAVAILABLE");
      let topic;
      try { topic = await dialogs.getForumTopicOrReload(command.peerId, command.threadId); }
      catch { return failResult("WEBK_TOPIC_SNAPSHOT_FAILED"); }
      if (!topic) return failResult("WEBK_TOPIC_NOT_FOUND");
      return {
        ok: true,
        snapshot: {
          read_inbox_max_id: Number.isSafeInteger(Number(topic.read_inbox_max_id)) ? Number(topic.read_inbox_max_id) : null,
          unread_count: Number.isSafeInteger(Number(topic.unread_count)) ? Number(topic.unread_count) : null,
          top_message: Number.isSafeInteger(Number(topic.top_message)) ? Number(topic.top_message) : null,
          pinned: topic.pFlags?.pinned === true,
          closed: topic.pFlags?.closed === true,
        },
      };
    }

    return failResult("WEBK_STRUCTURE_COMMAND_UNSUPPORTED");
  }, command);

  if (!result?.ok) fail(result?.error || "WEBK_STRUCTURE_FAILED");
  return result;
}

export async function webKListConversationStructure(page, limit) {
  return invoke(page, { type: "conversation_structure", limit: boundedLimit(limit, 50) });
}

export async function webKSetConversationPin(page, providerRef, pinned) {
  if (typeof pinned !== "boolean") fail("WEBK_CONVERSATION_PIN_STATE_INVALID");
  return invoke(page, {
    type: "conversation_pin_set",
    peerId: safeProviderRef(providerRef),
    pinned,
  });
}

export async function webKListTopics(page, providerRef, limit, offsetIndex = 0) {
  return invoke(page, {
    type: "topic_list",
    peerId: safeProviderRef(providerRef),
    limit: boundedLimit(limit, 100),
    offsetIndex: boundedOffset(offsetIndex),
  });
}

export async function webKTopicReadSnapshot(page, providerRef, threadId) {
  if (!Number.isSafeInteger(threadId) || threadId <= 0) fail("INVALID_PROVIDER_TOPIC_REFERENCE");
  const result = await invoke(page, {
    type: "topic_snapshot",
    peerId: safeProviderRef(providerRef),
    threadId,
  });
  return result.snapshot;
}
