# Torchiko CRM — accepted local NO-SEND sales slice

Status: **IMPLEMENTED AND LOCALLY VERIFIED — PREPARE / REVIEW / STATE ONLY.**

Worktree: `C:\Users\tomsc\Downloads\PathFinder-crm-research-20260919`

Branch: `codex/torchiko-crm-research-20260919`

Accepted foundation: `aace14ae6ee8bc87b8556dcdfda208004d20c87d`

Implementation commit: `5799a7b76f4de210d755a03acacd3e281f78b6cd`.

`NO-SEND-ACCEPTANCE-RECEIPT.json` binds that exact source commit to 26 retained evidence
files; `SOURCE-MANIFEST.json` pins the 45 owned committed files, including the seven
accepted screenshots. The final vault handoff also records the evidence commit.
Do not reimport the workbook, redo importer acceptance,
recreate the database, replace identities, clean retained evidence or make a new worktree.

## What is now native

The existing prospect detail view owns source/contact UNKNOWN state, the real Research
Gate result and bounded questions, writing-context preparation, immutable draft revision
editing, exact operator review, synthetic correspondence/reply preparation and native
suppression/hold. It always states **SEND AUTHORIZED: NO**. There is no send button.

Original reusable components remain in the vault. The CRM adapter preserves their
source identities, research snapshots, WLT packet and actual zero-entry Approved Language
snapshot. Prepared drafts use the existing native draft owner, not parallel staging JSON.

The original 16,725 organizations/venues/opportunities, all import lineage/source data,
85 territories and 8,212 UNKNOWN/UNKNOWN candidates are unchanged. Readback compared
every pre-existing row's full-row digest/count across 42 tables with the saved before
receipt: **42/42 identical**. The single additional organization/venue/contact is clearly
synthetic and exists solely to exercise the native suppression owner.

## Open the local review surface

From this worktree, use the existing guarded launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-local-crm-research.ps1 -Mode preview -EnableSalesPreparation
```

Open `http://127.0.0.1:58618/dev-fixtures/prospect-research` and search for:

The task-owned preview was stopped after browser acceptance; the retained database
stays running. The launcher above starts the same verified local route again. Next's
temporary generated route-type pointer was returned to its pre-task value; both
pre-existing dirty generated files remain outside the implementation commit.

| Prospect                            | Accepted state / purpose                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Halim Time & Glass Museum           | Browser-tested source context, revision editing and exact no-send review.          |
| Evanston History Center             | Native revision-chain / immutability / stale-review acceptance.                    |
| Dave's Down to Earth Rock Shop      | **SYNTHETIC** inbound and proposed normal response revisions. No real venue reply. |
| Campbell House Museum               | Form routing, with no email recipient or form submit capability.                   |
| Centralia Historical Society Museum | Real bounded research-required state; no invented Composer crosswalk.              |
| SYNTHETIC CRM Sales Hold            | Native suppression wins before preparation and review progression.                 |

The fifth supported original component record is Miniature Museum of Greater St. Louis.
No operator authorization is inferred from source facts, public routing, WLT style,
language candidates, fixture history or a review click.

## Local evidence

Evidence root: `artifacts/crm-sales-20260921-r001`.

- Original component tests: 16 passed. Focused DB/API/dashboard tests: 27 + 10 + 28 passed.
- Initial integrated DB/API acceptance: 57 passed; final repeat on the hardened source:
  55 passed (the two first-ingestion-only checks already exist in the initial receipt).
- Edge browser acceptance: 44 passed, seven screenshots; desktop 1440, narrow 375 and
  320 pixels; keyboard Tab/Enter; no overflow; zero automated accessibility violations.
- Original-row readback: 27 checks passed and all 42 original table projections identical.
- DB, API and dashboard typecheck passed. Public/tenant/raw-SQL/agent-inventory boundaries
  are recorded separately; no new agent binding was granted.

Accepted browser receipt: `browser-r003/receipt.json`. Earlier failed browser and
serialization receipts remain retained but are not acceptance authority. The first
browser attempt hit initial hydration timing; the second exposed unstable implicit
form labeling. The final source uses explicit labels and passed the full browser path.

Final readback has 16 immutable NO-SEND draft revisions, 17 preparation records including
retained unusable legacy attempts, two explicitly synthetic historical messages, and
one disabled FAKE provider. Campaigns, batches, frozen recipients, outbox, follow-ups,
real messages, enabled providers, approved drafts and human inbound classifications
remain zero. Repeated acceptance intentionally appends revision evidence; it does not
reset history. Exact final counts are in `retained-readback-r001.json`.

## Deliberate boundaries and retained baseline findings

Composer's accepted source contract currently admits five exact source-row crosswalks.
Other native prospects show research/human questions and fail visibly before unsupported
Composer preparation. No live research executor or automatic generative writer was added.
The original Composer creates the source-bound writing context; the operator supplies
the normal draft. WLT/risk results are visible; full claim/meaning validation remains
required. Exact read-review is not semantic certification, Tom approval or send approval.

The unrelated admin-modularity gate still reports the **unchanged accepted**
`prospect-crm-core.ts` at 440 lines. The broader AI-provider scanner also encounters
SDK manifests in retained `.next-crm-build` / `.next-crm-build-final` standalone evidence.
Those existing build artifacts and source files were not deleted, rewritten or hidden.
This is local slice acceptance, not a claim that every broad release gate is green.

See `NATIVE-OWNERS.md` for the single proven schema extension,
`ADAPTER-CONTRACTS.md` for identity/authority rules and `UX-AUDIT.md` for visual evidence.
Preserve the pre-existing dirty `apps/dashboard/next-env.d.ts` and
`apps/dashboard/tsconfig.json`; they are not owned by this implementation commit.
