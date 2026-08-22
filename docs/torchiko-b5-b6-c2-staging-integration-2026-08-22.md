# Torchiko B.5 → B.6 → C2 staging integration verification

Verification date: 2026-08-22

## Outcome

The three reviewed local lineages are integrated on
`codex/torchiko-b5-b6-c2-staging-integration-20260822` without touching staging or production:

- B.5 recovery: `abce1e52158fae7f297d7772038f07cc02fb1d2d`;
- B.6 Google Workspace source foundation: `1acbb732ac8034240b5745150abba486064f2c01`;
- C2 commercial-decision enforcement, cherry-picked from
  `a32c4701d9ae4a2da4dcfb6267add726e67b6c84` as
  `edeeaa1b597d1f6045ee882f3401ea36522c17de`.

B.6 is a direct descendant of the exact B.5 recovery commit. The original and integrated C2
commits have the same stable patch ID,
`65381ea9a2c029985bccdbfc4939ed6f5e9d6f23`.

No remote was pushed, no hosted environment was accessed, and no deployment, customer contact,
email, outreach, live billing, legal filing, or production mutation occurred.

## Integration repairs

The combined branch exposed three local-only integration issues, all repaired with regression proof:

1. Restored the billing feature-flag test fixture to the router's composite-key `findUnique`
   contract and asserted the exact `billing-ui-v1` lookup.
2. Gave the B.6 Google HTTP test doubles the real fetch argument types so the integrated API build,
   typecheck, and lint compile the call tuples correctly.
3. Extended the guarded staging migration manifest from the reviewed B.5 boundary (141 migrations,
   193 public tables) to the B.6 boundary (143 migrations, 195 public tables). The gate now admits
   the exact B.5-complete ledger and advances it through only the two reviewed B.6 migrations.

## Disposable migration proof

Two exact-name loopback PostgreSQL databases were created with the guarded disposable wrapper.

Fresh-chain proof on `pathfinder_disposable_b5_b6_c2_20260822`:

- migrations: 143 finished, 0 unfinished, 0 rolled back, 0 with failure logs;
- final migration: `20260822064500_add_calendar_meet_source_models`;
- public tables: 195;
- invalid indexes: 0;
- unvalidated constraints: 0.

Exact sequence proof on `pathfinder_disposable_b5_then_b6_c2_20260822`:

- B.5 branch applied exactly 141 migrations and produced 193 public tables;
- the integrated branch then applied only
  `20260822063000_add_google_source_retention_foundation` and
  `20260822064500_add_calendar_meet_source_models`;
- final state: 143 migrations, 195 public tables, 0 unfinished or rolled-back migrations, 0 invalid
  indexes, and 0 unvalidated constraints.

## Verification

Passed from the integrated worktree:

- `pnpm test` with a forced uncached monorepo run;
- `pnpm build` across all 14 workspaces;
- `pnpm typecheck` across all 25 tasks;
- `pnpm lint` across all 14 workspaces;
- Prisma generation and schema validation;
- the four staging migration predeploy tests, including exact 134 → 143 and 141 → 143 suffixes;
- 52 billing tests and 49 environment/Stripe-mode tests;
- 13 focused billing, rollout, and Gmail OAuth API tests;
- 14 focused no-send and environment-boundary database tests;
- staging configuration, public-surface, client-bundle secret, and AI-provider boundary checks.

The baseline still reports one documented temporary AI-worker boundary exception, Turbo output-file
warnings, and the existing web `<img>` lint warning. No new warning was introduced by this
integration.

## Preserved safety state

- Stripe remains test-mode-only. Live mode still requires production, an explicit kill-switch,
  and an owner-verified exact legal entity.
- Torchiko LLC remains unverified. This integration does not set or infer a legal identity.
- Gmail reconnection continues to force `deliveryEnabled: false`; no sending trigger was added.
- Calendar and Meet rollout remains off until an owner-controlled staging deploy and OAuth/IAM
  checks are completed.
- Production remains untouched.

## Exact external boundary

The local integration is ready for owner review. The next action requires authenticated Git/Railway
control and is intentionally not performed here:

1. Review this branch and merge its exact tip into the owner-controlled staging branch; do not merge
   or deploy it to production.
2. Configure the staging predeploy approval token exactly as
   `torchiko-staging-lineage-to-147-20260822`, deploy the exact merged SHA to Railway staging, and
   preserve Stripe test mode, all live-mode flags off, Google source rollout flags off, and prospect
   delivery off.
3. Record the merged SHA and the guarded predeploy result. Codex can then verify the 147-row/198-table
   staging ledger, service health, test-mode billing, no-send state, and production isolation.

Google DRS inspection/OAuth re-consent and the hosted Stripe sandbox lifecycle remain later,
separate owner-login gates. They are not prerequisites for merging the dark integration branch, but
they are prerequisites for enabling their respective staging workflows.
