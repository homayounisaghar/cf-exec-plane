# Dexa V282 - Exhaustive input-schema and minimal-intent audit (staged, not production)

**Status:** Staged on the owner VPS. NOT published as a production rollout. This report is source-code and schema-test evidence, not a claim of real-world provider output verification or task completion.

## Tool inventory and evidence

| Scope | Count | Verified today | Limit |
|---|---:|---|---|
| Live CF MCP tools | 183 | Real published input schemas and sample JSON inputs validated 183/183 | Five mirror/operator tools are intentionally not admitted to owner model |
| CF-backed Dexa capabilities | 178 | Input JSON Schema EXACTLY matches live MCP tools 178/178; parser compiles one minimal intent for each | 171 provider output shapes have no independently audited native-output adapter |
| Android native actions | 47 | Java-derived input schemas 47/47; synthetic native input passes parser; contact SMS dataflow compiled and tested without sending | This is not 47 real phone-side execution tests |
| Internal Dexa capabilities | 8 | Input schemas validated 8/8; generator owns result paths and checks | dexa.android.status is intentionally internal; some semantic operations require source provenance |
| GH/RD alternative-only external cards | 104 | Counted and excluded from Dexa model because no bound Dexa input schema/runtime | NOT independently verified as callable by Dexa |
| CF provider output shapes with independently reviewed adapters | 12 | Enumerated in Dexa output adapter registry | Only partial semantic record coverage |
| CF provider output shapes lacking such adapters | 171 | Flagged individually as OUTPUT_UNVERIFIED | Must NOT invent expected JSON fields |

## Two requested fixes - current proof and deployment gate

1. **Catalog/input:** Live schemas and non-executing JSON input fixtures 183/183, 47/47, 8/8. Native contacts.search now documents `contacts.items`, not the erroneous `result.contacts.items`. Synthetic examples are **not** claims about real tool responses. Full output conformance remains NOT verified for 171 CF tools.

2. **Minimum first-model output:** A staged `dexa.intent.v1` supports semantic capability ID and only owner-grounded args. Rana deterministically compiles deps/checks/output for each of 178 CF-bound direct invocations and 47 native direct invocations. One verified adapter compiles named-contact -> exact on-phone number -> SMS without model JSON paths or test SMS. More complex dependent multi-tool workflows have not all been given backend-owned data adapters; forcing this model schema everywhere now risks regressions.

**Release decision:** Do not switch the live model prompt or production engine until the remaining output/chain semantics are explicitly covered and end-to-end no-regression tests are passed. The live v281 system is intentionally left unchanged.

## Independent tests

- `python3 scripts/audit_tool_schemas_v282.py`: 183/183 CF, 47/47 Android, 8/8 internal; 0 schema/example errors.
- `node --test engine/test_dexa_v282_every_tool_minimal.mjs`: six contract/compile tests including loops through 178+47 and a synthetic actual-shape contact-to-SMS binding; no physical side effects.
- `node --test web/test_dexa_v282_minimal_prompt.mjs`: three checks for compact index, no model output paths, and v1 parser preservation.
- `node --test web/test_catalog_publication_v2.mjs`: seven tests for durable catalog outbox.
- Legacy regression tests include assertions that predate current v281 (`304` cards instead of actual `290`, old web build labels, and mandatory v3 model fields). Such failures must be identified separately from new behavioral failures; passing new tests is not enough to ship.

## Remaining 171 CF output-adapter gaps

These are identified by **actual live tool names**, not assumptions. Unknown outputs remain opaque raw provider data; do not invent shapes or model paths.

`alibaba_api_probe, alibaba_attachment_get, alibaba_capability_gaps, alibaba_capability_list, alibaba_contact_search, alibaba_conversation_list, alibaba_conversation_search, alibaba_delete, alibaba_file_upload, alibaba_file_upload_chunk, alibaba_mark_read, alibaba_message_get, alibaba_message_list, alibaba_message_replies, alibaba_message_search, alibaba_mute, alibaba_pin, alibaba_reply, alibaba_screenshot, alibaba_send, alibaba_unread_list, audio_upload, bale_api_probe, bale_attachment_get, bale_capability_gaps, bale_capability_list, bale_contact_search, bale_conversation_list, bale_conversation_search, bale_delete, bale_edit, bale_file_send, bale_forward, bale_mark_read, bale_mark_unread, bale_message_list, bale_message_replies, bale_message_search, bale_mute, bale_pin, bale_react, bale_reaction_get, bale_reply, bale_screenshot, bale_send, bale_unread_list, bale_voice_send_file, cf_auth_mode_set, cf_auth_owner_add, cf_auth_owner_remove, cf_auth_status, cf_mirror_close, cf_mirror_open, cf_mirror_screenshot, cf_mirror_sources, cf_mirror_status, cf_oauth_approve, cf_whoami, github_auth_start, github_auth_status, github_branch_create, github_branch_list, github_commit_get, github_commit_list, github_compare, github_file_delete, github_file_get, github_files_push, github_pr_create, github_pr_list, github_pr_merge, github_repo_list, github_search_code, github_tree_list, onshape_artifact, onshape_capability_list, onshape_catalog_refresh, onshape_operation_execute, onshape_operation_status, onshape_reauth, onshape_resolve, onshape_screenshot, onshape_status, onshape_verification_submit, server_admin_approve, server_admin_cancel, server_admin_list, server_admin_output, server_admin_request, server_exec, server_file_copy, server_file_delete, server_file_edit, server_file_fetch, server_file_link, server_file_list, server_file_move, server_file_read, server_file_search, server_file_stat, server_file_upload, server_file_write, server_job_kill, server_job_list, server_job_output, server_job_status, server_status, telegram_attachment_get, telegram_capability_gaps, telegram_capability_list, telegram_contact_search, telegram_edit, telegram_file_send, telegram_file_upload, telegram_file_upload_chunk, telegram_forward, telegram_mark_read, telegram_mark_unread, telegram_message_replies, telegram_message_search, telegram_mute, telegram_react, telegram_reaction_catalog, telegram_reaction_get, telegram_reply, telegram_screenshot, telegram_semantic_invoke, telegram_send, telegram_voice_send_file, voice_convert, wechat_cached_media_get, wechat_cached_media_list, wechat_capability_gaps, wechat_capability_list, wechat_chat_view, wechat_contact_search, wechat_conversation_search, wechat_file_upload, wechat_file_upload_chunk, wechat_mark_read, wechat_mark_unread, wechat_message_search, wechat_mute, wechat_native_voice_capability, wechat_pin, wechat_screenshot, wechat_selected_conversation, wechat_send, whatsapp_attachment_get, whatsapp_capability_gaps, whatsapp_capability_list, whatsapp_contact_search, whatsapp_conversation_search, whatsapp_delete, whatsapp_edit, whatsapp_file_send, whatsapp_file_upload, whatsapp_file_upload_chunk, whatsapp_forward, whatsapp_mark_read, whatsapp_mark_unread, whatsapp_message_search, whatsapp_mute, whatsapp_pin, whatsapp_react, whatsapp_reaction_get, whatsapp_reply, whatsapp_screenshot, whatsapp_send, whatsapp_unread_list, whatsapp_voice_send_file`

## The 5 newer CF operator-only tools

`cf_mirror_close, cf_mirror_open, cf_mirror_screenshot, cf_mirror_sources, cf_mirror_status`

## Source / reproducibility

- Staged VPS release: `/home/cfserver/dexa-phase2-controlled-release-20261112/releases/dexa-web-v282-minimal-intents-contract-audit-20261115`
- Full per-tool ledger: `tool-contract-audit-v282.json` (all fields are synthetic, no owner real prompts).
- Model index preview: `intent-index-v282.md` (requires current authenticated owner history at publication time; the staged preview has empty history).

**Never assert complete catalog output verification or release until all of these requirements are actually met.**
