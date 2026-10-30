# WeChat local-media cache capability-ref r266 (secret-free source)

Canonical private source: `homayounisaghar/capability-fabric`, branch `project/personal-communications-gateway`, commit `9b218171dad6fdcde3cc97aed855c1f1c2ae1f2c`.

This public snapshot is a **minimal source-pinned single-module correction** over the currently live `r265-wa-caption-wechat-media-20261030` release. The old per-MCP-registration cache-adapter object lost a random 20-minute file-ref across requests. The new module's WeakMap retains the adapter for the same shared in-process material transport and root. It does not change the binary media bytes, WhatsApp caption, original 21 WeChat tool schema, disabled provider file-send, or unavailable native-voice send/get.

Release candidate `r266-wa-caption-wechat-cache-ref-20261030` preserves all 32 release files except the updated media-tool module and release-closure metadata. Exact release manifest SHA-256: `b9a01441be460b5beb8b7a9b96d6440577c2920e0d93abd63ee9d17a5c6074f7`. New module SHA-256 `3f0c5d0630003b0912d9cf6f225bd1009ad7769f4fb9890b664b72716e68ee84`. Caption source remains `264c4d9614551f2586dfcc157db61d8c99d81c6326e8d7b51123de37052c733d`.

No user media, WeChat account names, credentials, access tokens, session data, personal file references or ACL backup is included. Only synthetic tests are published. Three new cross-request/negative tests passed; eight existing WeChat media tests also passed on the source candidate.

This source/workflow commit **does not deploy**. An additional exactly one-file `server-bootstrap/control/cf-wechat-cache-r266/*.request` commit triggers the guarded backend-only deploy, with existing CF/DEXA and WhatsApp preservation checks. Verify the actual live service and new read/list/get operations rather than relying on workflow status. Do not mark the deprecated r264 workflow as current.
