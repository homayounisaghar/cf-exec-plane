# WeChat media r264 secret-free candidate (NOT DEPLOYED)

Canonical private source: `homayounisaghar/capability-fabric`, branch `work/wechat-media-tools-20261030`, source commit `d87e99d971a3d2abe641c414d5e3ef983b48bef3`.

Public candidate is a *minimal* source-pinned overlay on existing CF r263: one three-file patch, three new source modules, synthetic-only unit tests, manifest/closure and the guarded root activator. No private WeChat messages, accounts, screenshots, media, cache files, credentials or sessions have been published. The synthetic test fixture has no owner-specific filename.

Overlay reproduces the current 29-file CF r263 baseline (via public r261 snapshot + pinned r262/r263 Telegram patches), then changes only `server.js`, `wechat-preload.mjs`, and `compose.yaml`, adding media-cache acquisition/upload modules. Voice send/read and official arbitrary-file send are NOT qualified: the latter is disabled and cannot dispatch; cache results have no message/sender identity proof.

Offline checks: 32-file SHA-pinned release/closure consistency, unchanged r263 Telegram/Onshape contract, generated JS syntax, Python YAML compose structural check, 8/8 synthetic tests. The owner's VPS reports critically low memory headroom, and the activator fails before restart if MemAvailable is below 1,536,000 kB. No immutable `.request` has been committed; no live service restarted, no CF tool published.

A subsequent separately-reviewed public workflow plus exactly one immutable `server-bootstrap/control/cf-wechat-media-r264/*.request` is required to activate. Do not confuse preparation with release confirmation. Before publishing, warn of the CF backend restart and refresh the existing connector after live tool exposure; verify service and exact tools directly. Do not bypass any host safety gate.
