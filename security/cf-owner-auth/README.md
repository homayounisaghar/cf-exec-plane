# CF-server owner authorization cutover

This directory contains the temporary multi-owner authorization layer for the personal CF-server connector.

## Security model

- Existing secret MCP URL remains the outer ingress barrier.
- ChatGPT `_meta["openai/subject"]` is converted to a server-secret HMAC fingerprint; raw subject values are never persisted.
- Multiple owners are represented by an allowlist of `cfsub_<sha256>` fingerprints.
- Optional `openai/organization` pinning uses the same HMAC approach.
- Modes:
  - `disabled`: authorization completely bypassed; root recovery can use this.
  - `observe`: default first-deploy state; never blocks and logs only anonymized caller fingerprints.
  - `enforce`: all MCP tool calls except `cf_auth_status` require an authorized owner.
- `cf_auth_status` stays available so a prospective owner can obtain their anonymized fingerprint.
- The first owner can only be bootstrapped through the root/server CLI. There is no "first caller wins" path.
- Existing owners may add or remove additional owners. The last owner cannot be removed through MCP.
- State and the fingerprint HMAC key live under the persistent `/agent-state/owner-auth` directory and therefore survive releases.

This is a temporary defense-in-depth control for the current shared ChatGPT connector. It does not turn untrusted client-supplied metadata into a cryptographic identity boundary. Long term, use OAuth/token-backed authenticated principals and authorize every request against that authenticated principal.

## Moving-production workflow

Do not build a permanent candidate from an old live release. At cutover time:

1. Read the current live build and authoritative `LIVE_NOW.md`.
2. Identify the exact current qualification snapshot.
3. Copy this security directory into a clean checkout.
4. Apply the overlay to that latest snapshot with the next unused sequence/release id:
   `node security/cf-owner-auth/apply-owner-auth-overlay.mjs <latest-snapshot> <new-snapshot> <sequence> <release-id>`
5. Verify it:
   `node security/cf-owner-auth/verify-owner-auth-snapshot.mjs <new-snapshot>`
   `node --test <new-snapshot>/owner-auth.test.mjs`
   plus the ordinary Onshape Fast R12 qualification.
6. Re-read the live build immediately before publishing. If production moved, discard the stale candidate and reapply the overlay to the new latest snapshot.
7. Merge the security workflow guard and publish the owner-auth candidate together. A fresh owner-auth state starts in `observe`, so existing chats remain functional after the brief service restart.
8. From each intended owner chat, call `cf_auth_status` and collect its `subject_fingerprint`.
9. On the VPS/root path, atomically bootstrap all intended owners. Recommended first pass is `observe`.
10. Confirm expected owner fingerprints and organization behavior, then switch to `enforce`.
11. Verify from an owner chat that ordinary tools work and from a non-owner workspace account that ordinary tools return `CF_OWNER_AUTH_FORBIDDEN`.
12. Update `LIVE_NOW.md` only after direct readback proves the new live state.

## Root recovery

From inside the running server container/release environment, point `CF_OWNER_AUTH_STATE_DIR` at the persistent owner-auth directory and use:

- `node owner-auth.mjs status`
- `node owner-auth.mjs bootstrap --owner cfsub_... [--owner cfsub_...] --mode observe`
- `node owner-auth.mjs disable`

Root recovery is intentionally independent from MCP owner authorization.

## Release-chain invariant

Once the security workflow changes are merged, both qualification and deployment pipelines require the owner-auth module, tests, runtime copy, manifest hashes, and server integration markers. A later feature release that accidentally drops the authorization layer must fail before deployment.
