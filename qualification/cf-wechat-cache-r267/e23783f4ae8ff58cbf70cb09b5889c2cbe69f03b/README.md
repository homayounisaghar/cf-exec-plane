# CF WeChat cached-media reference r267 (secret-free candidate)

Source authority: private capability-fabric, branch project/personal-communications-gateway, source commit e23783f4ae8ff58cbf70cb09b5889c2cbe69f03b.

This snapshot is NOT itself a deployment and contains NO message text, screenshots, personal filename, authenticated session material, credentials or media. Only two modules change from the already live r266: a process-wide per-cache-root short-lived token ledger independent of per-MCP-request upload-wrapper identity, and an adapter that atomically consumes tokens before material side effects with TTL, bounded capacity, file-stat and symlink checks. All other 29 runtime files are unmodified, including WhatsApp caption. No arbitrary WeChat file send or native voice claims are added.

Release: onshape-vps-fast-r100-direct-orbit1-paa-storage-r267-wa-caption-wechat-stable-ref-20261030. SHA-256 of 32-file manifest: 55994a63eee9e5b06f7e94437f04f4b758631022b20de91895b5cac47175a399. Guarded activator requires active r266, exact live SHA hashes, >=1536000 kB RAM, idle Dexa, preserves gateway and caption, and rolls back a failing backend-only restart.

Qualification: 9/9 new synthetic, 8/8 legacy WeChat media tests PASS. Fresh-wrapper differential regression fails on r266 and passes on r267. A prior live r266 full cached-image 3649-byte HTTP download matched the expected SHA-256; r267 live E2E acceptance must be performed AFTER actual service release.

Activation is only triggered by a separate, immutable, single-file request under server-bootstrap/control/cf-wechat-cache-r267/*.request; no other control path may be used. After the release request, verify from the live CF service; never infer success from workflow status. The connector's cached tool list may need refresh after exposure changes.
