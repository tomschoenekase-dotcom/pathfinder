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
2. Migration admission: the staging predeploy admits the exact 254-migration manifest and
   preserves the frozen 252 predecessor. Only the reviewed 253–254 suffix is accepted; partial
   253-row ledgers and divergent or failed rows stop admission. Fresh disposable PostgreSQL proof:
   254 finished migrations, 277 public tables, eight empty operator tables, no invalid indexes or
   unvalidated constraints; guarded replay reports no pending migrations. See
   `docs/evidence/migration-252-254-admission-2026-09-30.json`. Hosted preservation proof is separate.
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

- Venue sources, content changesets, release reads and private previews (packet W05) are built but not released.
  They need migration `20261002090000_add_venue_sources` (two additive tables, no data change), the isolated
  website-research worker runtime (`INTAKE_V1_WEBSITE_RESEARCH_WORKERS_ENABLED`) for captures, and, for previews,
  `GUEST_PREVIEW_SIGNING_SECRET` (32+ characters) on the web and dashboard services plus `NEXT_PUBLIC_WEB_URL`.
  Without the secret no preview link can be minted or accepted. Typed content changes also need
  `GENERALIZED_CONTENT_CAPABILITIES_ENABLED`. No live provider, real site or hosted system was exercised.
  Campaign membership, customer invite and support triage now exist; see `release-proposal-operator-crm-20261001.md` for the
  migration 255 candidate, which is a separate release.
- Clerk `strict` reverification accepts a password if the account has no second factor; Tom's
  account should have a passkey or MFA.
- Refresh reuse revokes the whole connection (no grace window), per the plan.
