# External database incident stop

> **Incident state: ACTIVE. External database commands are not authorized.**

An earlier command unintentionally applied pending Prisma migrations through an externally
configured Supabase connection. Tom has since identified the affected project and authorized a
bounded read-only assessment, but no authenticated ledger, schema, or recovery evidence has been
collected. No external database write, migration, seed, rollback, or remediation command may run;
inspection remains limited to that authorized assessment.

This stop supersedes every migration or seed instruction in older PathFinder plans, handoffs,
backlogs, and runbooks. Historical documents remain useful design evidence, but they are not
operator authority. Do not infer safety from an environment label, a familiar hostname, an old
instruction, or a command being described as staging-only.

Local destructive verification remains permitted only through the repository's disposable-only
wrapper against an exact-name `pathfinder_disposable_*` database on exact loopback, with no tunnel
or proxy. That local contract is documented in `docs/railway-staging.md`; it is not an escape hatch
for any external host.

## Conditions for lifting the stop

As of 2026-08-13, Tom identified project `PathFinder` (non-secret ref
`zpacmfkomonxeqdiadtz`) and authorized the bounded read-only assessment. Conditions 1 and 2 below
are satisfied. The endpoint is reachable, but no authenticated ledger, schema, or backup evidence
has been collected; the stop remains active.

1. Tom identifies the affected external project/environment.
2. Tom authorizes a bounded read-only assessment plan.
3. The resulting evidence establishes migration state, affected schema, and backup/recovery
   posture, and Tom explicitly approves the remediation, roll-forward, or rollback plan plus every
   external database inspection or write that plan authorizes.
4. Only after that explicit approval, this file, the guarded documents, and the static safety test
   are updated together in one reviewed stop-lifting commit.

Until all four conditions are met, the incident state remains `ACTIVE` and executable external
database instructions must stay absent from active runbooks.
