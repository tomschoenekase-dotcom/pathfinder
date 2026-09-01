# Torchiko staging current truth — 2026-09-01

> **Migration instruction status: HISTORICAL — DO NOT EXECUTE.**

This is the bounded current snapshot of the authorized Railway `staging` environment. It records
exact deployment evidence; it does not authorize production, provider activation, customer contact,
live billing, destructive data work, or deferred marketing, branding, wordmark, or Tochi work.

## Active admitted release

- Git revision: `723ecc583a57ac79e56489f4a9a5865cb946d505`.
- Candidate-branch GitHub Actions run `33464160442` and staging-branch run `33466345529` passed all
  58 steps.
- Web deployment: `9e5d51f6-3a69-47ab-8796-ccc50bbcf5e0`, image
  `sha256:f4301d851c0e0914dbc32539854c34e3a5d6d71630fe70984a849afc261a83a4`.
- Dashboard deployment: `e2e198a1-84b1-4c5e-8b88-1b9d84ef0688`, image
  `sha256:49b2882ab1880098f17774ca1da3c171762901cecfdeb3cdedaad1f200254e47`.
- Worker deployment: `05aee47d-b230-470b-8b56-656e8ba2d393`, image
  `sha256:bceadf83c02eae3bcf41a1185d6c7575b7e5d33547100eceb6852d12e692d36e`.

The guarded migration rollout accepted the immutable 206-row predecessor and applied only
`20260901020000_support_tenant_wide_ai_accounting`. The exact 207-file manifest, complete 207-row
ledger, integrity checks, and 232 public tables passed. A later Git-identified web predeploy proved
the already-complete 207/207 path independently. The migration and local-upload admissions are both
`0`.

## Exact topology, health, and runtime proof

The fail-closed topology verifier admitted exactly one Git-identified deployment for each required
service. Every deployment was `SUCCESS`, every service had exactly one `RUNNING` instance, and every
revision and immutable image digest matched the identities above. Public health reported the exact
release and reviewed database, Redis, and storage resource identities with database and queue `up`.
The exact hosted staging profile passed 19/19 with zero failed or blocked gates.

The final bounded runtime audit found zero service error rows and zero web/dashboard HTTP 5xx rows.
Founder-absence history retained complete observations for five consecutive UTC dates,
`2026-08-28` through `2026-09-01`, with zero failed observations. It remains explicitly
`sevenDayReviewReady=false`, `certificationGranted=false`, and `launchGate=false` until real retained
history, private-ledger readback, and human review satisfy the remaining gates.

## Failure and rollback record

Deployment `878c3c4d-71df-404f-9771-fd3bb81aa885` failed closed before migration because the guard
omitted the actual immutable 206-row hosted boundary. Repair checkpoint `723ecc58` added that exact
boundary and a regression proving its only valid successor. Existing staging remained healthy
through the failed attempt. The prior exact staging revision
`46e404777f197e53bfb181b9953e25423e72aa54` and its immutable deployment evidence remain the rollback
reference.

Production `master` remained exact `b00b2c24a0a99f7f4be0f882fa84647921a19c48`; production was not
selected or mutated. This snapshot does not prove current backup/PITR recovery, provider-backed model
quality, authenticated operator/client journeys, physical-device behavior, customer contact, or live
billing. Every future release must repeat exact migration admission, service topology, health,
runtime, and hosted-profile verification.
