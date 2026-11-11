# Dexa Superapp — public execution artifacts (not canonical project state)

> **OWNER ARCHITECTURE DIRECTIVE — 2026-11-12.** Before proposing engine, dashboard, Android/WebView or voice-pipeline modifications, authorized project agents **must read** the canonical private [Dexa Owner Operation Success Manifesto](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa/OWNER_OPERATION_SUCCESS_MANIFESTO.md) and current [Dashboard state](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/PROJECT_STATE.md). The private repository, with active engine ref resolved from `WORK_REGISTRY.md`, is the source of truth. This folder contains public release artifacts, not a competing continuity root.

## Minimal owner-settled rules for readers of this public directory

- Optimize for the **owner's actual intended operation succeeding**, not check-heavy rejection, bureaucratic validation or resource optimization. Every extra gate, timeout, wait, retry limit or readback must show *positive, concrete usefulness*; arbitrary "fail closed" defaults are insufficient.
- Blind Effort UI commands are intentional: do **not** add a blocking selected-Effort readback step merely because the value is not verified.
- A deterministically derivable recipe field (such as `deps` from real `source.step`/`$ref` references) should be computed by code when justified, not demanded redundantly from a model and then used as an arbitrary rejection point. This is a design review direction, not a claim of deployed normalizer behavior.
- Browser 2 Voice Chat acts as a **natural Persian text reader**. Its deliberately unusual RTC-audio sampling and speaker mute/unmute state machine hides disposable opening speech and exposes only the intended body. Current owner-provided wrapper begins `Say "Hi", then pause for exactly 0.8 seconds.`; it **no longer asks for an integral**. First post-request speech and first qualifying silence unmute the speaker; after renewed speech, the following qualifying silence ends the cycle. Startup ding before send is excluded. Do not call this anti-pattern merely because it is complex; diagnose *real* audio failures. Separate Read Aloud mode uses a copy-only header without this pause protocol.
- The voice dashboard handles independent, completed conversational turns; all answered turns, including clarifications, partial work and failures, enter the rolling history. This is separate from provider-effect truth.
- Preserve authorization, verified target identity, prevention of duplicate irreversible effects and honest Rana receipts **when a concrete adverse real-world effect justifies them**. Blindly removing all guards would also violate the owner's success criterion.

**Documentation only; this README does not modify or publish runtime code.** The forensic first phase must inspect and report without changing the source or deployments.

[Owner-approved forensic audit prompt](https://github.com/homayounisaghar/capability-fabric/blob/main/projects/dexa-dashboard-superapp/OPERATION_PATH_FORENSIC_AUDIT_PROMPT.md)
