# Dexa owner catalog snapshot fix

Canonical private source: `homayounisaghar/capability-fabric`, ref `work/dexa-autonomous-loop-20261020`, commit `80889b67fb0809fc1c854c79e649ae8787fa62bb`.

Observed last failed mission: code `CATALOG_OWNER_SNAPSHOT_INVALID`, failed before any planner request or provider effect because the owner snapshot validator expected 293 rows after Kata was correctly refreshed to 291 external cards plus 1 local writer (292). This scoped diff derives the expected count from the current catalog registry and updates static test expectations and model-visible count text. Public plane contains only secret-free patch and tests. The deploy script checks exact source hashes, drains active missions, makes an isolated candidate and runs provider-free tests, restarts only `dexa-main.service`, verifies mission durability, planner readiness, and new snapshot, and rolls back on failure. The failed owner mission is not automatically replayed.
