# External database incident stop

> **Production incident state: ACTIVE. Staging exception state: APPROVED.**

On 2026-08-19, Tom approved a staging-only Railway release with a hard USD 10 spending ceiling.
The exception permits writes only to a separately identified, synthetic-only staging database and
staging-only storage. It permits the reviewed migration wrapper, application deployment, and
synthetic QA described in `railway-staging.md`. It does not authorize any production inspection,
write, migration, restore, seed, credential reuse, customer email, or provider-enabled worker.

An earlier command unintentionally applied pending Prisma migrations through an externally
configured Supabase connection. Tom has since identified the affected project and authorized a
bounded read-only assessment. That assessment found a clean 52-migration production ledger with no
failed rows or checksum divergence. Tom then authorized a password-prompted logical backup and an
isolated PostgreSQL 17.6 production-lineage rehearsal. The verified backup exists outside the
repository, and its separate local recovery restore passed, but the project has no provider backup
or PITR. No production database write, migration, seed, rollback, or remediation command may run;
production inspection remains limited to the completed authorized assessment.

The production stop supersedes every migration or seed instruction in older PathFinder plans,
handoffs, backlogs, and runbooks. Historical documents remain useful design evidence, but they are
not operator authority. Do not infer safety from an environment label, a familiar hostname, or an
old instruction. The staging exception exists only through the fail-closed wrapper and exact
resource confirmations in the active Railway runbook.

Local destructive verification remains permitted only through the repository's disposable-only
wrapper against an exact-name `pathfinder_disposable_*` database on exact loopback, with no tunnel
or proxy. That local contract is documented in `docs/railway-staging.md`; it is not an escape hatch
for any external host.

## Staging-only exception controls

The staging exception is narrower than resolving the production incident:

1. `RAILWAY_ENVIRONMENT` must be exactly `staging`, the provider release SHA must equal the
   separately recorded 40-character release SHA, and the database resource identity must equal the
   operator-confirmed staging identity.
2. Pooled and direct database hosts plus the database name must match separate confirmation values.
   The known production project reference is explicitly denied.
3. The data policy is `synthetic-only`; restoring or copying production lineage is not authorized.
4. The reviewed staging migration wrapper is the only active external migration entrypoint. It
   defaults to refusal and requires an explicit one-run opt-in.
5. Workers remain provider-disabled with zero queues. Clerk, storage, Redis, and database resources
   must be staging-only. The release stops before total new monthly staging spend exceeds USD 10.
6. Every deployed application service uses the same immutable release SHA. Production branches,
   resources, variables, and services remain untouched.

## Conditions for lifting the production stop

As of 2026-08-13, Tom identified Supabase ref `zpacmfkomonxeqdiadtz` and authorized the bounded
read-only assessment. The dashboard identifies organization `PathFinder` and project display name
`tomschoenekase-dotcom's Project`. Conditions 1 and 2 below are satisfied. The assessment established
the ledger and relevant schema state. A verified logical backup and production-lineage rehearsal
are now complete, but the Free-plan project has neither scheduled backups nor PITR. The rehearsal
also required a repair for legacy `venue.updated` analytics events. Condition 3 remains unsatisfied
until Tom separately reviews the evidence and explicitly approves a production cutover plan and
each production write it proposes; the production stop remains active.

1. Tom identifies the affected external project/environment.
2. Tom authorizes a bounded read-only assessment plan.
3. The resulting evidence establishes migration state, affected schema, and backup/recovery
   posture, and Tom explicitly approves the remediation, roll-forward, or rollback plan plus every
   external database inspection or write that plan authorizes.
4. Only after that explicit production approval, this file, the guarded documents, and the static
   safety test are updated together in one reviewed production stop-lifting commit.

Until all four conditions are met, the production incident state remains `ACTIVE`. The sole active
external database instruction is the staging-only wrapper admitted above; production instructions
must stay absent from active runbooks.
