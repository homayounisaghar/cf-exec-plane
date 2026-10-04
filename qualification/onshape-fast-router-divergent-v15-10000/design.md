# V15 10k divergent holdout design

Status: PRE-SCORE FROZEN DESIGN
Purpose: fresh post-V14 generalization stress test for the fast Onshape language router.

## Critical review of V14 method

V14 was useful but still too benchmark-shaped:

- 25 equal families x 40 cases made the distribution regular and predictable.
- Most cases were single-turn, single-effect utterances with shallow discourse.
- Politeness/filler variation was wider than true semantic variation.
- Negation scope, self-correction, contrast ("نه X، Y"), exceptions and conditionals were thin.
- Context existed, but stale/conflicting context and incompatible selection types were underrepresented.
- Numeric stress focused on spoken Persian but not enough on Persian digits, decimal punctuation, zero/negative/extreme values, repeated/corrected quantities or count bounds.
- Code-switching was mostly clean English/Persian token mixing; typos, ASR-like omissions, transliterated Persian and punctuation-free phone input were thin.
- Professional CAD language beyond the currently admitted operation set was underrepresented. A real modeler asks about sketches, constraints, shell, hole, sweep, loft, revolve, mirrors, configurations, drawings, exports, manufacturing intent, clearances and feature-tree strategy.
- Literal masking was tested, but literal values containing units, operation names, punctuation and multiple semantic keywords can be more adversarial.
- Multi-action was present but dependency/temporal structure ("اول ... بعد ...", "اگر ...", "به جز ...") was not broad.
- There were few minimal-pair clusters where one token flips polarity, target, unit, or action family.
- The model-fallback cohort was too small to characterize realistic planner behavior under genuinely unfamiliar professional phrasing.

## V15 construction principles

V15 uses 10,000 unique utterances across 50 semantic families (200 each), with cross-cutting variation in:

- terse fragments, direct imperatives, polite requests, conversational requests, long explanatory commands;
- Persian, English, code-switching and a bounded amount of transliterated/ASR-like input;
- word order, filler, punctuation and mobile-typing forms;
- explicit targets, deictic references, verified context, missing context and conflicting context;
- positive/negative polarity, correction, contrast, cancellation and dependent sequencing;
- valid/invalid quantities, Persian digits, decimal variants, unit aliases, extreme/zero/negative bounds;
- literal payloads with keyword collisions and opaque free text;
- single effect, two-effect residue, conditional/dependent multi-step requests;
- currently admitted operations, unsupported-but-plausible CAD commands and open-ended engineering judgment.

The corpus is deliberately closer to what a professional modeler might say to a competent junior operator than to a grammar worksheet.

## Statistical rule

The corpus source is committed before any score is observed. After first scoring, the corpus and gold labels become regression-only and must never be tuned. Any failure discovered by V15 must be fixed generically in the router and validated on V12/V13/V14/V15 plus a later fresh holdout.

Production effects: none.
