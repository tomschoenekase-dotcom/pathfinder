# Release card: Release B + Dot operator + Safari keyboard fix

One combined release, one backup, staging first, then production. Nothing here is automatic.

## What ships

- Release B (draft PR 34): MCP venue creation and appearance tools, migration 253.
- Dot operator (this branch): OAuth 2.1 server, grants, proposals, autonomy dial, plans, one-tap
  approval, read tools, six proposal kinds, `/admin/operator`, migration 254
  (`20261001090000_add_operator_oauth`, eight new platform tables, additive only).
- Safari keyboard fix (`claude/torchiko-safari-keyboard`): visitor chat composer stays above the
  iPhone keyboard; `?debugViewport=1` readout.

## Gate before any deploy

1. Exact-head CI green (`ci`, `visitor-launch`, `railway-iac`) on the final integration SHA.
2. Migration admission: the staging predeploy still admits only the frozen 252-migration
   manifest (253 and 254 are pinned as "unadmitted candidates" in
   `scripts/staging-migration-predeploy.test.mjs`). A reviewed commit must advance the admitted
   boundary to 254 (expected count, manifest hash, reviewed suffix) before staging can migrate.
3. Preserved-data path from `docs/staging-release-workflow.md`: pause autodeploy, freeze the SHA,
   drain writers, release-bound backup plus restore proof, held migration
   (`PATHFINDER_STAGING_MIGRATION_ONLY_HOLD=1`), then code-only web, then dashboard and workers.
4. Production: only the healthy exact staging SHA, after the production incident stop is lifted
   and a release-specific migration approval is recorded.

## Settings (names only; set in each environment separately)

- `OPERATOR_OAUTH_ENABLED` (leave `false` until the release is healthy, then `true`)
- `OPERATOR_OAUTH_ISSUER` (that environment's dashboard origin)
- `OPERATOR_OAUTH_PEPPERS` (new random value per environment; never reuse staging's in production)
- `OPERATOR_OAUTH_REDIRECT_ORIGINS` (the connector's callback origin)
- `OPERATOR_OAUTH_ALLOWED_USER_IDS` (Tom's user ID)

With the flag off, every operator path answers 404 and the migration's tables stay empty.

## After release

1. iPhone Safari: open a guide chat, tap the box, type. If wrong, reload with `?debugViewport=1`
   and screenshot.
2. Connect the Dot: `/oauth/arm` → ChatGPT Custom Tool, URL `<dashboard>/api/operator/mcp`,
   OAuth → approve the consent page. If registration fails, the rejected callback origin is in
   `/admin/operator` → Audit (`oauth.register`); add it to `OPERATOR_OAUTH_REDIRECT_ORIGINS`.
3. First test: "build a test bot" → tap Approve on the plan link. Check Audit shows every call.

## Known limits

- Parked kinds (no canonical action yet): campaign membership, venue source, customer invite,
  support triage. The tools are not listed to the Dot.
- Clerk `strict` reverification accepts a password if the account has no second factor; Tom's
  account should have a passkey or MFA.
- Refresh reuse revokes the whole connection (no grace window), per the plan.
