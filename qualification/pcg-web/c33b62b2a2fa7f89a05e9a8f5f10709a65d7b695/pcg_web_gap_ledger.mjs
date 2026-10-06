// Capability gap ledger.
//
// Purpose: whenever a request that reaches this server cannot be satisfied —
// an unknown operation, a missing or malformed argument, a refused ingress
// call, an unconfirmed effect — the fact is recorded on the server instead of
// being lost inside a chat transcript. The accumulated ledger is what the next
// release reads to decide what to build or fix.
//
// Discipline:
//   * argument NAMES are recorded, never argument VALUES, so no message text,
//     handle, phone number or file content can enter the ledger;
//   * entries are aggregated by (operation, error code) so repeated failures
//     become a count, not an unbounded log;
//   * the file is bounded in entry count and rewritten atomically, so a full
//     disk or a crash cannot corrupt the running service.

import fs from "node:fs";
import path from "node:path";

const LEDGER_PATH = process.env.PCG_WEB_GAP_LEDGER || "/run/pcg/capability-gaps.json";
const MAX_ENTRIES = 400;
const MAX_DETAIL_CHARS = 400;
const MAX_NAMES = 24;
const MAX_EXAMPLE_ARG_SETS = 3;

function boundedString(value, max) {
  if (typeof value !== "string" || !value) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

function argumentNames(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.keys(args)
    .filter((name) => typeof name === "string" && name.length <= 64)
    .slice(0, MAX_NAMES)
    .sort();
}

function readLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.entries)) return parsed;
  } catch {}
  return { schema: "capability-fabric.gap-ledger.v1", entries: [] };
}

function writeLedger(ledger) {
  const tmp = LEDGER_PATH + ".tmp";
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  fs.renameSync(tmp, LEDGER_PATH);
}

// Never let bookkeeping break a request: every failure here is swallowed.
export function recordGap({ operation, code, state, detail, args, surface } = {}) {
  try {
    const op = boundedString(operation, 128) || "UNKNOWN_OPERATION";
    const errorCode = boundedString(code, 128) || "UNKNOWN_ERROR";
    const ledger = readLedger();
    const now = new Date().toISOString();
    const key = `${surface === "ingress" ? "ingress" : "semantic"}|${op}|${errorCode}`;
    let entry = ledger.entries.find((item) => item.key === key);
    if (!entry) {
      if (ledger.entries.length >= MAX_ENTRIES) {
        // Drop the least recently seen gap rather than growing without bound.
        ledger.entries.sort((a, b) => String(a.last_seen).localeCompare(String(b.last_seen)));
        ledger.entries.shift();
      }
      entry = {
        key,
        surface: surface === "ingress" ? "ingress" : "semantic",
        operation: op,
        error_code: errorCode,
        first_seen: now,
        last_seen: now,
        occurrences: 0,
        states: [],
        guidance_detail: null,
        observed_argument_sets: [],
      };
      ledger.entries.push(entry);
    }
    entry.last_seen = now;
    entry.occurrences += 1;
    const observedState = boundedString(state, 32);
    if (observedState && !entry.states.includes(observedState)) entry.states.push(observedState);
    const guidance = boundedString(detail, MAX_DETAIL_CHARS);
    if (guidance) entry.guidance_detail = guidance;
    const names = argumentNames(args);
    const signature = names.join(",");
    if (!entry.observed_argument_sets.some((set) => set.join(",") === signature)) {
      entry.observed_argument_sets.push(names);
      if (entry.observed_argument_sets.length > MAX_EXAMPLE_ARG_SETS) entry.observed_argument_sets.shift();
    }
    ledger.updated_at = now;
    writeLedger(ledger);
  } catch {}
}

export function summarizeGaps({ limit = 100 } = {}) {
  const bounded = Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_ENTRIES ? limit : 100;
  const ledger = readLedger();
  const entries = ledger.entries
    .slice()
    .sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0)
      || String(b.last_seen).localeCompare(String(a.last_seen)))
    .slice(0, bounded)
    .map((entry) => ({
      surface: entry.surface,
      operation: entry.operation,
      error_code: entry.error_code,
      occurrences: entry.occurrences,
      first_seen: entry.first_seen,
      last_seen: entry.last_seen,
      states: entry.states,
      guidance_detail: entry.guidance_detail,
      observed_argument_sets: entry.observed_argument_sets,
    }));
  return {
    ledger_path: LEDGER_PATH,
    updated_at: ledger.updated_at || null,
    distinct_gaps: ledger.entries.length,
    total_occurrences: ledger.entries.reduce((sum, entry) => sum + (entry.occurrences || 0), 0),
    returned: entries.length,
    entries,
  };
}
