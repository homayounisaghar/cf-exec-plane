import fs from "node:fs";
import { randomUUID } from "node:crypto";

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

export function createConversationIdentity(registryFile) {
  function readRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      if (!parsed || parsed.schema !== 1 || typeof parsed.conversations !== "object" || Array.isArray(parsed.conversations)) {
        throw new Error("invalid handle registry");
      }
      if (parsed.messages === undefined) parsed.messages = {};
      if (typeof parsed.messages !== "object" || Array.isArray(parsed.messages)) throw new Error("invalid message registry");
      if (parsed.attachments === undefined) parsed.attachments = {};
      if (typeof parsed.attachments !== "object" || Array.isArray(parsed.attachments)) throw new Error("invalid attachment registry");
      if (parsed.topics === undefined) parsed.topics = {};
      if (typeof parsed.topics !== "object" || Array.isArray(parsed.topics)) throw new Error("invalid topic registry");
      return parsed;
    } catch (err) {
      if (err?.code === "ENOENT") return { schema: 1, conversations: {}, messages: {}, attachments: {}, topics: {} };
      fail("HANDLE_REGISTRY_INVALID");
    }
  }

  function writeRegistry(registry) {
    const temp = registryFile + "." + process.pid + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(registry) + "\n", { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, registryFile);
    fs.chmodSync(registryFile, 0o600);
  }

  function opaqueConversationHandle(providerRef) {
    if (typeof providerRef !== "string" || providerRef.length < 1 || providerRef.length > 128 || providerRef.includes("\0")) {
      fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
    }
    const registry = readRegistry();
    let handle = registry.conversations[providerRef];
    if (typeof handle !== "string" || !handle.startsWith("tgchat:")) {
      handle = "tgchat:" + randomUUID();
      registry.conversations[providerRef] = handle;
      writeRegistry(registry);
    }
    return handle;
  }

  function providerRefForHandle(handle) {
    if (typeof handle !== "string" || !handle.startsWith("tgchat:") || handle.length > 128 || handle.includes("\0")) {
      fail("INVALID_CONVERSATION_HANDLE");
    }
    const matches = Object.entries(readRegistry().conversations)
      .filter(([, value]) => value === handle)
      .map(([providerRef]) => providerRef);
    if (matches.length === 0) fail("UNKNOWN_CONVERSATION_HANDLE");
    if (matches.length !== 1) fail("AMBIGUOUS_CONVERSATION_HANDLE");
    return matches[0];
  }

  function opaqueMessageHandle(providerRef, mid) {
    if (typeof providerRef !== "string" || providerRef.length < 1 || providerRef.length > 128 || providerRef.includes("\0")) {
      fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
    }
    if (!Number.isSafeInteger(mid)) fail("INVALID_PROVIDER_MESSAGE_REFERENCE");
    const registry = readRegistry();
    const key = providerRef + ":" + mid;
    let handle = registry.messages[key];
    if (typeof handle !== "string" || !handle.startsWith("tgmsg:")) {
      handle = "tgmsg:" + randomUUID();
      registry.messages[key] = handle;
      writeRegistry(registry);
    }
    return handle;
  }

  function providerMessageRefForHandle(handle) {
    if (typeof handle !== "string" || !handle.startsWith("tgmsg:") || handle.length > 128 || handle.includes("\0")) {
      fail("INVALID_MESSAGE_HANDLE");
    }
    const matches = Object.entries(readRegistry().messages)
      .filter(([, value]) => value === handle)
      .map(([key]) => key);
    if (matches.length === 0) fail("UNKNOWN_MESSAGE_HANDLE");
    if (matches.length !== 1) fail("AMBIGUOUS_MESSAGE_HANDLE");
    const key = matches[0];
    const split = key.lastIndexOf(":");
    if (split <= 0) fail("MESSAGE_REGISTRY_INVALID");
    const providerRef = key.slice(0, split);
    const mid = Number(key.slice(split + 1));
    if (!Number.isSafeInteger(mid)) fail("MESSAGE_REGISTRY_INVALID");
    return { providerRef, mid };
  }

  function opaqueAttachmentHandle(providerRef, mid, slot) {
    if (typeof providerRef !== "string" || providerRef.length < 1 || providerRef.length > 128 || providerRef.includes("\0")) {
      fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
    }
    if (!Number.isSafeInteger(mid)) fail("INVALID_PROVIDER_MESSAGE_REFERENCE");
    if (typeof slot !== "string" || !/^[a-z0-9_-]{1,32}$/.test(slot)) fail("INVALID_PROVIDER_ATTACHMENT_REFERENCE");
    const registry = readRegistry();
    const key = providerRef + ":" + mid + ":" + slot;
    let handle = registry.attachments[key];
    if (typeof handle !== "string" || !handle.startsWith("tgatt:")) {
      handle = "tgatt:" + randomUUID();
      registry.attachments[key] = handle;
      writeRegistry(registry);
    }
    return handle;
  }

  function providerAttachmentRefForHandle(handle) {
    if (typeof handle !== "string" || !handle.startsWith("tgatt:") || handle.length > 128 || handle.includes("\0")) {
      fail("INVALID_ATTACHMENT_HANDLE");
    }
    const matches = Object.entries(readRegistry().attachments)
      .filter(([, value]) => value === handle)
      .map(([key]) => key);
    if (matches.length === 0) fail("UNKNOWN_ATTACHMENT_HANDLE");
    if (matches.length !== 1) fail("AMBIGUOUS_ATTACHMENT_HANDLE");
    const key = matches[0];
    const last = key.lastIndexOf(":");
    const previous = key.lastIndexOf(":", last - 1);
    if (previous <= 0 || last <= previous + 1) fail("ATTACHMENT_REGISTRY_INVALID");
    const providerRef = key.slice(0, previous);
    const mid = Number(key.slice(previous + 1, last));
    const slot = key.slice(last + 1);
    if (!Number.isSafeInteger(mid) || !/^[a-z0-9_-]{1,32}$/.test(slot)) fail("ATTACHMENT_REGISTRY_INVALID");
    return { providerRef, mid, slot };
  }

  function opaqueTopicHandle(providerRef, topicId) {
    if (typeof providerRef !== "string" || providerRef.length < 1 || providerRef.length > 128 || providerRef.includes("\0")) {
      fail("INVALID_PROVIDER_CONVERSATION_REFERENCE");
    }
    if (!Number.isSafeInteger(topicId) || topicId <= 0) fail("INVALID_PROVIDER_TOPIC_REFERENCE");
    const registry = readRegistry();
    const key = providerRef + ":" + topicId;
    let handle = registry.topics[key];
    if (typeof handle !== "string" || !handle.startsWith("tgtopic:")) {
      handle = "tgtopic:" + randomUUID();
      registry.topics[key] = handle;
      writeRegistry(registry);
    }
    return handle;
  }

  function providerTopicRefForHandle(handle) {
    if (typeof handle !== "string" || !handle.startsWith("tgtopic:") || handle.length > 128 || handle.includes("\0")) {
      fail("INVALID_TOPIC_HANDLE");
    }
    const matches = Object.entries(readRegistry().topics)
      .filter(([, value]) => value === handle)
      .map(([key]) => key);
    if (matches.length === 0) fail("UNKNOWN_TOPIC_HANDLE");
    if (matches.length !== 1) fail("AMBIGUOUS_TOPIC_HANDLE");
    const key = matches[0];
    const split = key.lastIndexOf(":");
    if (split <= 0) fail("TOPIC_REGISTRY_INVALID");
    const providerRef = key.slice(0, split);
    const topicId = Number(key.slice(split + 1));
    if (!Number.isSafeInteger(topicId) || topicId <= 0) fail("TOPIC_REGISTRY_INVALID");
    return { providerRef, topicId };
  }

  function protectedConversationType(providerRef) {
    if (/^[1-9][0-9]*$/.test(providerRef)) return "user";
    if (/^-100[1-9][0-9]*$/.test(providerRef)) return "channel";
    if (/^-[1-9][0-9]*$/.test(providerRef)) return "chat";
    fail("UNCLASSIFIABLE_PROVIDER_CONVERSATION_REFERENCE");
  }

  return {
    opaqueAttachmentHandle,
    opaqueConversationHandle,
    opaqueMessageHandle,
    opaqueTopicHandle,
    providerAttachmentRefForHandle,
    providerMessageRefForHandle,
    providerRefForHandle,
    providerTopicRefForHandle,
    protectedConversationType,
  };
}
