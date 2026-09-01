# Torchiko staging current truth — 2026-09-01

> **Migration instruction status: HISTORICAL — DO NOT EXECUTE.**

This is the bounded current snapshot of the authorized Railway `staging` environment. It records
exact deployment evidence; it does not authorize production, provider activation, customer contact,
live billing, destructive data work, or deferred marketing, branding, wordmark, or Tochi work.

## Active admitted release

- Git revision: `a3e66de5a1231aca6df5d150ca7bcd81831dd784`.
- Candidate-branch GitHub Actions run `33540059467` and staging-branch run `33543975717` both passed
  on this exact revision.
- Web deployment: `b4d39999-6c42-42a4-9069-53ce5c86e16a`, image
  `sha256:3a11d66fa11f3c43fcd107d08b436e9b39beafec53e62f71d64e1c4804797a86`.
- Dashboard deployment: `cbba90a2-7e99-40d5-865d-77daf64da717`, image
  `sha256:eecf8b2bbc74c4e8d01bb3c28033fae2e0e0e93bfa1e219c86f0c8a637a7b8dc`.
- Worker deployment: `6c624ba7-1067-4436-a97e-5801c314141f`, image
  `sha256:572068ddbfd1eb0331d5d1cda04ebe6b2082ef66f876a1952a1f0206711f7c59`.

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

The final bounded 24-hour runtime audit found zero service error rows and zero web/dashboard HTTP 5xx
rows. The exact 168-hour reconciliation across the preceding and current worker deployments retained
32 complete events with zero failures on `2026-09-01`. The release rollover changed the retained
release identity, so the exact reconciler reports one consecutive complete day; it remains explicitly
`sevenDayReviewReady=false`, `certificationGranted=false`, and `launchGate=false` until real retained
history, private-ledger readback, and human review satisfy the remaining gates.

The exact staging release profile passed 19/19. Its JSON and Markdown evidence hashes are
`91F8CE891A34D55FE9BA6192D0506C57029A4047EC062E627906C60594D13F5F` and
`EBB0D61043D7CEE898B35E150C539EE7378E9A1E09CAAEE343A6CD1313AE2E5A`.

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
