# Unified CF speech-to-text contract (r263)

Canonical source: `homayounisaghar/capability-fabric` ref `work/pcg-unified-asr-tool-r263-20261026` commit `e9779d35e1f34211817acd3d3441f44f5b9c80bf`. Patch onto CF r262's publicly pinned source. Expose only `audio_transcribe` for 1–20 audio items and status; remove the two obsolete directly registered transcription tools and user-visible speed overrides, including the accidental reaction-get argument. Internal Soniox pacing and fixed slicing/merge remain unchanged. Deploy only the CF backend, preserve gateway; rollback to r262 on failed health.
