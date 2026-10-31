# WeChat native voice r268 — qualification snapshot

This is a secret-free, source-only snapshot for offline qualification. It is NOT deployed, is NOT a CF tool, and does not contain credentials, session state, user media, or personal project continuity.

## Provenance
Canonical source/state: `homayounisaghar/capability-fabric`, branch `project/personal-communications-gateway`.
- `voice_plan_guard.py`: blob `943ca30acfe41a96d53aaec051bf256501e69914`
- `test_voice_plan_guard.py`: blob `290bed0ae23c127a38fb1daa1263c6859bc357ef`
- `wx_voice_fail_closed_candidate.py`: blob `ed16bb4f21c2b406f2e4d2242747a57c9f87eb8e`
- `wx_voice_complete_candidate.py`: blob `4e8348cd333c51bed7b7e0d7db1fb2727f8cb5b6`

Pinned upstream v11 baseline remains the 23-file manifest at `homayounisaghar/cf-exec-plane` commit `09d827dca096a8ff9af8cd14b2c31700d2204f45`, MANIFEST Git blob `f2483bbd1e52f725085528966296786adc38a6ef`. The calibrated v11.16 timing overlay provenance is commit `70375de0b56531f520882b9668c1264d2db1c439`, blob `b9ba12628b2cf7c36476192f5e36f78fb64a3e0d`.

## Current candidate behavior
- Retains the original no-fixed-count chunk planner and 59-second absolute owner ceiling.
- Uses a conservative 54-second per-chunk source cap in the complete-drain runtime overlay until the live client proves a larger cap remains below the provider's roughly 60-second hold limit.
- Waits for synchronous `pacat` completion before release; timeout/nonzero exit is IN_DOUBT, not success.
- Stops on any prior source/chunk marker, keeps markers forever, and never continues past an uncertain chunk.
- Counts only provider-fresh outbound `VOICE_SENT_VERIFIED` receipts.
- A source-level marker closes the replay hole if the chunk segmentation changes.
- The receipt verifier explicitly does not claim full source-audio fidelity merely from a UI bubble.

## Qualification scope
Offline planner/receipt tests cover the 59-second ceiling, 54-second complete-drain cap, tiny-tail rebalance, 1200-second inputs, contiguous coverage, ordering, and rejection of uncertain or over-limit receipts. They do NOT test the live WeChat UI, audio fidelity, a real 59-second send, multipart provider delivery, or CF registration.

No deployment request is present in this branch. The live service remains unchanged until host-side runtime qualification and a provider-fresh owner-self multipart test succeed.
