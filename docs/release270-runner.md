# Release270 manual Linux checkout runner

This runner remains manual and staging-only. It retains exact Git HEAD/clean status,
full270 manifest, staging resource, existing opt-in/hold, backup/restore, consumer,
catalog/security, queue and durable journal checks. Production and localhost URLs
are refused by operational main, including `--preflight`. No source-seal fallback
or arbitrary Prisma directory is supported.

Use a real detached checkout with Git, Node20.19+ (qualification uses22), pnpm9.15.4,
frozen installed dependencies and a generated repo-local Prisma client. Redis resolves
from packages/jobs, Prisma from packages/db. Preflight checks dependencies/source
without connecting; it does not approve mutation. Node/engine overrides are refused.
Keep proof/journal outside checkout and private. The runner never releases a hold;
successful held execution returns exit2. An armed incomplete or outcome-unknown
journal requires authoritative session/ledger/catalog reconciliation before retry.
Local process termination does not prove PostgreSQL server cancellation.

The separate release270-runner workflow exercises PostgreSQL17 (staging match) and16
regression plus Redis7 using fictional data and no service credentials. Its harness
bootstraps real267 migrations, populates fictional rows, advances to269, dumps and
restores a distinct database, rehearses270 independently, then runs actual core,
advisory lock, Prisma child, readback and Redis preservation. Fixture consumer
transport proves protocol mechanics only. Synthetic resource labels never route
network connections. Operational main continues refusing those local endpoints.
Artifacts record actual PostgreSQL/source/manifest and restore/reference evidence.
Reference270 uses a third fresh database replayed from unchanged migrations.
Logical restore can renumber enum ranks and redistribute literal-array casts in
CHECK deparsing; those reviewed semantic equivalences belong only to restore
verification. Operational catalog/cutoff checks remain exact. Unknown security
hash differences stop qualification and retain diagnostic receipts for review.

Hosted qualification must pass at the exact final source. Docker is required for
that CI proof. Local unit tests alone do not establish real SQL/Redis/OS behavior.
Service tags are currently recorded by version; immutable image digest pinning is
still required before treating the packaging as a reproducible operational image.

Operational blockers remain: an authenticated fresh complete deployment/consumer
hold collector, independently reviewed staging backup/restore/new grants reference
on matching PostgreSQL17/roles/default privileges, exact-source hosted private-network
access, and current evidence. Static inventory JSON cannot answer fresh challenges;
main therefore fails closed until a real independently owned transport supplies
each challenged observation. Never restamp an old inventory.

Application rollout wiring is also separate: Dockerfile.web.staging still invokes
the historical269 predeploy, which rejects a270 schema. This qualification adds no
automatic predeploy wiring and changes no old guards, application images, worker
flags, feature flags or migration SQL. Migration completion alone does not make
the current application image deployable. A separately reviewed release270
application admission/wiring change is required before application rollout.
