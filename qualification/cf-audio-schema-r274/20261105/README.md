# CF audio_transcribe: ChatGPT/schema parity repair r274

## Ground truth and observed failure (2026-11-05)
Live CF catalog describes `audio_transcribe.files[]` as **object** (client_file_id, file, upload_id or telegram_message_handle). The cached direct ChatGPT typed tool instead describes `files?: string[]`. Sending a string passes the client schema but fails CF server; sending an object passes CF but fails the client schema. Read-only `cf_tool_read` using the live schema successfully transcribed four owner Telegram voice notes. An audit of all 194 direct CF tools found this to be the only primitive array-item mismatch.

## Exact source root-cause candidate
CF r263 registered `_meta: {"openai/fileParams":["files"]}` on a **structured object-array**. The native ChatGPT file-attachment bridge coerces the annotated parameter into string file references at the client boundary; such metadata is not valid for this structured array. This is a connector metadata/schema mismatch, not an ASR engine or Telegram media defect.

## Bounded correction
Remove precisely that metadata line from the `audio_transcribe` registration, preserving the actual `z.array(z.object(...))` input schema, batch/status behavior, native file-reference field in each structured item, Telegram handles, upload_id and all other tool registrations. No sidecars, new tools, or duplicated runtimes.

`patch_audio_schema.py` enforces an exact one-line-only delta on the release source; `test_audio_schema_r274.mjs` guards the mismatch and scans all tool registrations for the same dangerous structured-array metadata combination. The generic `cf_tool_read` path remains available for reconciliation. Whether ChatGPT automatically maps a newly attached file into the nested `files[].file` field needs separate client proof; do not claim that a direct native attachment handoff was tested simply because Telegram handles work.

## Release
Only via public secret-free execution plane, immutable .request, staged root-pinned release, guarded healthy backend-only restart and readback. Then update canonical LIVE_NOW.md and state after confirmed deployment. The user must refresh the existing connector (and possibly open a new ChatGPT conversation) for a fresh direct-tool signature; there is no second connector.
