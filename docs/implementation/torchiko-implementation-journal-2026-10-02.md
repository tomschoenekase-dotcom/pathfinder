# Torchiko implementation journal — packet r001 (2026-10-02)

Branch `claude/exciting-einstein-bl59qp`, based on `origin/master` `26a9e7e` (same tree as deployed production
`9f726af`) plus the operator-program journal commits `c58bf0a`, `08276b1`. Environment: cloud container, no hosted
database, no Stripe/Clerk/Gmail send credentials, Chromium only (no Playwright WebKit), no physical device.
Result vocabulary: PASS / FAIL / NOT RUN / BLOCKED. "Implemented" never means "verified on a provider/device".

## Baseline and safety (G0)

- Repo instructions read (CLAUDE.md; no AGENTS.md). Incident boundary `docs/database-incident-stop.md` read: production
  incident ACTIVE by default; no hosted DB access used in this run.
- Operator production release `9f726af` with migration 255: recorded complete in
  `torchiko-operator-checkpoints.md` (2026-10-01 entries, three-service acceptance PASS). This satisfies the W13
  prerequisite; CI changes were made only afterwards.
- Environment issues: `cdn.sheetjs.com` blocked by network policy (local-only substitute `xlsx@0.18.5`, never
  committed); GitHub push 403 (Claude GitHub App/access missing) — all commits local; git bundle sent to the owner.
- Local baseline before changes: `apps/web` vitest 70 files / 534 tests, 1 failure needing `pnpm characters:sync`
  (environmental), then green.

## Workstream log

| Lane                  | Commit(s)            | Outcome                                                                             |
| --------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| W01 mobile chat       | `8e9c6b6`, `f3e75c7` | One viewport model; send dismisses keyboard; single-line hint; device protocol      |
| W02 cursors           | `c2c3a22`            | Query-bound opaque cursors on every operator list; honest `complete`                |
| W02 operator page     | `4470a6e`, `5809015` | Root cause: server page used a value from a `'use client'` module; per-panel errors |
| W02/W06 look-and-feel | `dca1ae1`            | Same defect class on the client portal page; repo-wide boundary test                |
| W02 unknown create    | `6d18ea2`            | Pre-persistence failures reported as not-recorded; provider reconciliation by op id |
| W06 notices (A15)     | `51129cd`            | Shared lifecycle; isActive never means live; idempotent end                         |
| W09 billing           | `36f5337`, `b3e4ad8` | Explicit 14-state model; webhook tenant-mismatch, ordering, grace, fixture guards   |
| W13 CI                | `c5155e6`            | Fail-safe dependency-aware plan; master flake fixed; always-resolving gate          |
| W15 business prep     | `f3e75c7`            | CityPASS drafts (unsent), NYC research plan                                         |
| Docs safety           | `c86d1ac`            | Required historical/incident markers                                                |

Later lanes (W03, W04, W05, W07/W11, W08, W10) are recorded in the final handoff.

## Key findings with evidence

1. **Visitor blank band (IMG_0341).** `useChatViewportHeight` (55c3bb6) "verified" the pinned shell with
   `getBoundingClientRect`; iOS WebKit reports fixed-element rects in visual-viewport coordinates, so the pan was
   added twice. Removed the measurement loop; the shell follows `visualViewport` directly. Details and references in
   `torchiko-keyboard-device-protocol.md`.
2. **Clipped hint (IMG_0342).** WebKit wraps a textarea placeholder; replaced with a composer-drawn single-line hint.
3. **`/admin/operator` outage.** Commit 3917966 (2026-10-01) made `OperatorAdminView` a client module while the server
   page still called `OPERATOR_TABS.find(...)` on it → throws on every server render. `/look-and-feel` dotted into
   `BRANDING_REVIEW_SUBJECTS` from a client module (same class). Both fixed; test fails on the old shapes.
   Production log confirmation: NOT RUN (needs log access).
4. **Unknown customer create `36b36c4b-…`.** Caller-supplied operation ids; failures before the proposal insert were
   labelled `outcome: unknown` → `get_operation` NOT_FOUND. Now `NOT_RECORDED` (no effect, safe resend); real
   unknowns reconcile via Clerk metadata. Production reconciliation: BLOCKED (owner-approved read-only checks in
   `unknown-customer-create-reconciliation.md`).
5. **Billing blank page.** Panel returned `null` when disabled; every error collapsed to "not available". Now explicit
   states with retry; config/retrieval failure is never shown as no subscription.
6. **Master CI red on release merge.** Flaky `VenuePackageLifecycleControls` retry test (fenced click); test waits for
   re-enable. Operator branch also failed docs-safety test (missing markers) — fixed.

## Acceptance status (this run)

See the final handoff for the complete A01–A29 / M / B / L / CI / H / P / S table.

## Outreach (2026-10-02)

Acceptance row A04 (grounded outreach draft): the context pack is now built.

**What changed.** New read-only operator tool `crm.get_outreach_context` (capability `crm:read`, scope `platform`,
like the other CRM reads). Input: `organizationId`, optional `contactId`, optional `venueId`. Output is a bounded,
deterministic pack (`outreach-context-v1`): account and venue facts, the chosen contact with its draft/release
eligibility and suppression ledger entry, correspondence counts plus up to 5 recent message previews and 3 prior
drafts, up to 5 recorded notes, up to 10 source-evidence items with public https URL, research date and freshness,
up to 5 legacy research URLs, a fixed list of claims marked supported/unsupported, per-section
`total/returned/cap/truncated`, `limits.complete`, `limits.truncatedSections` and a source fingerprint.
No model call, no Gmail/network access, no send, no write, no migration (read model over existing tables).

**Files.** `packages/contracts/src/operator-mcp.ts` (tool name, input, output, catalog seed);
`packages/api/src/operator/outreach-context.ts` (pure builder); `packages/api/src/operator/tools/crm-outreach-context.ts`
(loader + registration, exported `loadOutreachContext`); `tools/index.ts`; manual text and `docs/operator/manual.md`;
tests (unit, contract list, reads list, disposable integration).

**Design decisions.**

- Contactability reuses the shared rule (`eligibilityForContacts` -> `evaluateProspectContactEligibility`, purpose
  `draft`, including an address blocked on another record). Any draft reason makes `drafting.allowed=false`;
  not-verified for release is only a warning. A requested contact is never overridden; auto selection takes the first
  draftable live contact (venue match first, then id) from a bounded 30-contact scan and says when it was bounded.
- When drafting is not allowed the pack withholds notes, evidence, legacy sources and message text, and omits the
  address. Message text of a person who may not be contacted is withheld even when drafting to someone else is allowed.
- Free text is untrusted-marked and address-redacted; source URLs must be public https (no credentials, localhost,
  private hosts); otherwise `urlWithheld` is set. Freshness: fresh <= 90 days, aging <= 365, stale beyond, unknown
  when no research date is stored (undated evidence is not citable).
- Tenant scope: prospect tables are platform-wide, so a prospect linked to a customer tenant (conversion or active
  relationship) outside the grant reads as NOT_FOUND, like any out-of-scope target. A contact or venue of another
  account is NOT_FOUND. Unknown arguments are rejected (strict schema).
- Tool and property names avoid send/charge/delete/autonomy/approved (`releaseEligible`, not a send word).
- Determinism: no clock reads inside the builder (uses the call's `now`), sorted keys, stable ordering with id
  tiebreakers. The fingerprint hashes record ids and versions, not time.

**Commands and results.** Disposable DB `pathfinder_disposable_einstein_outreach` (the `pathfinder_disposable_`
prefix is required by the migration script and the test guard; migration needs `PATHFINDER_DISPOSABLE_DATABASE_URL`).

- `pnpm install --frozen-lockfile`, `prisma generate`: PASS.
- `tsc --noEmit` in packages/api and packages/contracts: PASS.
- `pnpm lint` packages/contracts: PASS. packages/api: FAIL on one pre-existing unused import in
  `operator-company-reports-billing.disposable.integration.test.ts` (not touched here); my files lint clean.
- Contracts `pnpm test`: 73 files / 729 tests PASS.
- API `pnpm test`: 310 files passed, 1 failed (`venue-qr-pdf` timeout under full-suite load; passes alone, 6/6).
- Unit `outreach-context.test.ts`: 23 PASS.
- `RUN_OPERATOR_DB_INTEGRATION=1 vitest run src/operator --pool=forks --maxWorkers=1`: 42 of 43 files pass; the one
  failure was a 10s `beforeAll` hook timeout in `operator-discovery` under load; rerun alone with a longer hook
  timeout: 8/8 PASS. New `operator-outreach-context.disposable.integration.test.ts`: 10/10 PASS (healthy pack, suppressed
  contact, unsubscribed-only account with ledger, address blocked on an archived alias, do-not-contact account, missing
  venue/contact/evidence, truncation of evidence/notes/messages, determinism and fingerprint change, cross-tenant,
  cross-account, missing capability, strict args and no writes).
- `pnpm test:scripts`: 18 failures = the 14 known admission pins plus 4 in `ci-plan-workflow-wiring.test.mjs`, which
  fail identically on the clean base commit (checked with a stash) and are unrelated.
- NOT RUN: full-repo `pnpm typecheck`/`pnpm test` for other packages (only contracts and api touched).
