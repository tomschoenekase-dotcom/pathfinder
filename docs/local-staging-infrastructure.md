# Local staging infrastructure

`compose.local-staging.yml` is the canonical provider-dark dependency stack used by
`pnpm local-staging:up`. Every image is content-addressed so a fresh checkout cannot silently run a
different database, queue, object-store, initialization client, or malware-scanner image under a
mutable tag.

The readable tag documents the intended release family; the digest is the execution authority.
Docker must reject a tag/digest mismatch rather than substituting newer bytes. These pins govern
local engineering only and do not declare Railway, Supabase, or any production runtime version.

## Upgrade procedure

Treat an image refresh as a reviewed dependency change:

1. Choose the intended upstream release and review its security, compatibility, data-format, and
   licensing notes.
2. Pull the explicit release, inspect its repository digest and platform, and replace both the
   readable tag and digest in `compose.local-staging.yml` where a versioned tag exists.
3. Run `docker compose -f compose.local-staging.yml config` and
   `node --test scripts/local-staging-worker.test.mjs`.
4. Start the stack with `pnpm local-staging:up`; verify PostgreSQL migrations, Redis, MinIO bucket
   versioning/private access, ClamAV readiness, worker health, and application health.
5. Run the disposable upload/verification and golden-venue proofs before accepting an object-store,
   malware-scanner, or database change. Preserve the prior compose revision as the rollback.

Do not use `docker compose pull` as an unattended updater. It may verify or fetch the checked-in
digests, but changing a digest requires a reviewed repository change and the proof above.
