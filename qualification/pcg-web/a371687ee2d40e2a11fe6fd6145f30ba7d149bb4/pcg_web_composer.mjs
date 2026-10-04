import { webKPrepareLocalComposer } from "./pcg_web_webk_bridge.mjs";

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

function boundedComposerText(value) {
  if (typeof value !== "string") fail("COMPOSER_TEXT_INVALID");
  if (value.length < 1 || value.length > 512 || value.includes("\0")) fail("COMPOSER_TEXT_INVALID");
  return value;
}

export function createComposerFoundation(identity) {
  if (!identity || typeof identity.providerRefForHandle !== "function") fail("COMPOSER_IDENTITY_UNAVAILABLE");

  function resolveExactTarget(conversationHandle) {
    const providerRef = identity.providerRefForHandle(conversationHandle);
    if (typeof providerRef !== "string" || !providerRef) fail("COMPOSER_TARGET_RESOLUTION_FAILED");
    return providerRef;
  }

  async function prepareLocal(page, { conversationHandle, text }) {
    const providerRef = resolveExactTarget(conversationHandle);
    const boundedText = boundedComposerText(text);
    const effect = await webKPrepareLocalComposer(page, providerRef, boundedText);
    return {
      conversation_handle: conversationHandle,
      target_resolved: effect.target_resolved === true,
      local_composer_set: effect.local_composer_set === true,
      local_composer_restored: effect.local_composer_restored === true,
      local_before_present: effect.local_before_present === true,
      provider_draft_unchanged: effect.provider_draft_unchanged === true,
      provider_message_top_unchanged: effect.provider_message_top_unchanged === true,
      provider_read_state_unchanged: effect.provider_read_state_unchanged === true,
      server_draft_write_invoked: effect.server_draft_write_invoked === true,
      send_primitive_invoked: effect.send_primitive_invoked === true,
      typing_primitive_invoked: effect.typing_primitive_invoked === true,
      provider_content_model_visible: false,
      error: effect.error || null,
      outcome: effect.outcome || "FAILED",
    };
  }

  return {
    prepareLocal,
    resolveExactTarget,
  };
}
