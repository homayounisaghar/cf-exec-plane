// WeChat file-send receipt gate. A same-client accessibility observation is
// UI evidence only, never independent provider-authoritative confirmation.
export function evaluateWeChatFileSendReceipt(input) {
  const expected = input?.expected;
  const observed = input?.observed;
  if (!expected || !observed ||
      typeof expected.filename !== "string" ||
      !expected.filename || expected.filename.includes("/") ||
      !Number.isSafeInteger(expected.size_bytes) ||
      expected.size_bytes < 1) {
    return { state: "IN_DOUBT", reason: "RECEIPT_INPUT_INVALID", provider_confirmed: false, blind_retry_safe: false };
  }
  const rowsBefore = Array.isArray(observed.rows_before) ? observed.rows_before : [];
  const rowsAfter = Array.isArray(observed.rows_after) ? observed.rows_after : [];
  const occurrences = rows => rows.filter(row =>
    typeof row === "string" && row.includes(expected.filename)).length;
  const newRows = occurrences(rowsAfter) - occurrences(rowsBefore);
  const matched = observed.target === expected.target &&
    observed.selected_target === expected.target &&
    observed.direction === "out" &&
    observed.send_clicks === 1 &&
    observed.send_enabled_after === false &&
    observed.chooser_identity_verified === true &&
    observed.source_bytes_verified === true &&
    observed.source_size_bytes === expected.size_bytes &&
    newRows === 1;
  if (!matched) return {
    state: "IN_DOUBT", reason: "OUTBOUND_UI_RECEIPT_NOT_UNIQUE",
    provider_confirmed: false, blind_retry_safe: false
  };
  return {
    state: "UI_OUTBOUND_OBSERVED", verification_source: "same_client_accessibility",
    filename: expected.filename, size_bytes: expected.size_bytes,
    target: expected.target, provider_confirmed: false,
    provider_fresh: false, blind_retry_safe: false
  };
}
