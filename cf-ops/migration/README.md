> **DONE / OBSOLETE (2026-10-16):** this one-time migration is finished and the old server is deleted. The old user names below no longer exist anywhere. The only server user is `cfserver` (uid 1000). Do not run this tool.

# cfserver migration (NOT EXECUTED)
Renames uid 1000 `cfop_e79aa1fde5` to `cfserver` and moves `paa_remote` (994/980) workloads to it. Plan: capability-fabric `docs/cf-self-sufficient-tools/MIGRATION_PLAN_cfserver.md`.

- `cfserver_migrate.sh` default `--dry-run` (changes nothing), `--apply` (backup to /var/backups/cf-migrate-<ts>, stop, rename, chown paa paths, edit units/scripts, start, verify, auto-rollback on any failure; deletes the paa_remote account only after verify), `--rollback <dir>`, `--paa-remote=start|stop`.
- Run as root via `server_admin_request` with `background=true` (it stops capability-fabric-cf-ops).
- Offline simulation: `CF_MIG_ROOT` fake root + PATH stubs; `test/test.sh` = 27/27 PASS (2026-10-15): dry-run no change, apply, re-run refused, manual rollback restores byte-identical, auto-rollback on start failure and on verify failure, paa-remote stop option.
- Not yet done: root inventory on the host (blocked twice by the automated safety reviewer), root `--dry-run` on the host, owner decisions (time window, Desktop Commander, at-job tools).
- Known risk: paa-remote unit as cfserver gets HOME=/home/cfserver unless the unit sets HOME; Desktop Commander device config under /var/lib/capability-fabric/paa-remote may need Environment=HOME=... (check on dry-run).
