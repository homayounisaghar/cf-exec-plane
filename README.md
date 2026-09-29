# Capability Fabric Public Execution Plane

This public repository is the canonical **secret-free execution plane** for CI, qualification, bootstrap, and deployment-control tasks whose executable payload can be separated from private state and credentials.

Canonical source/state remains private in:
`homayounisaghar/capability-fabric`

## Routing rule
For an applicable secret-free task:

1. do **not** probe private-repository GitHub Actions first;
2. publish only the minimum secret-free candidate snapshot here;
3. bind the snapshot to exact private-source provenance (repo/ref/commit/release/manifest as applicable);
4. run the bounded public workflow;
5. record the verified result back in canonical private project state.

Private Actions are not a fallback prerequisite for this route.

## Privacy boundary
Never place here:
- credentials, tokens, signing secrets, or account secrets;
- browser/Onshape session data;
- private project/continuity state;
- user-private data unrelated to the bounded execution artifact.

This repository is an execution surface, not a second continuity root.

## Onshape
Current lightweight Onshape runtime qualification/deployment uses:
- `.github/workflows/onshape-fast-r12-ci.yml`
- `.github/workflows/onshape-fast-r12-deploy.yml`

Candidate snapshots live under:
`qualification/onshape-fast-r12/<canonical-source-commit>/`

The authoritative architecture/routing policy lives in the private canonical repository at:
`architecture/PUBLIC_SECRET_FREE_EXECUTION_PLANE.md`
