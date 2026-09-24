# Native CRM / component adapter contracts

## Authority and runtime

This implementation is LOCAL ONLY. The service requires development mode, both
local CRM flags, and the exact retained database URL at `127.0.0.1:58617` with database
`pathfinder_disposable_crm_research_20260919`. The launcher retrieves its existing
container credentials without writing them into files or passing them to Python.

Native routes use `adminProcedure`. New operations are intentionally **unbound** to
agent/MCP tools in the reviewed operation inventory. The loopback fixture is a
separate explicit opt-in: exact Host and Origin, same-origin fetch rules, a custom
CSRF header, JSON content type and a 64 KB streamed request limit. The original
read-only `/data` route is unchanged. The fixture actor is `local:no-send-operator`,
not an authenticated claim that Tom approved anything.

There is no operation for sending, approving delivery, freezing recipients, connecting
providers, researching websites, creating campaigns, or running an outbox.

## Native API

| Operation                                      | Input / identity                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `admin.getProspectSalesWorkflow`               | `{ venueId }`; read-only evaluation and native review projection.                                      |
| `admin.prepareReviewProspectSales` — `prepare` | Exact `venueId`, `expectedSnapshotHash`, and optional reply `answerText`.                              |
| Same operation — `save`                        | Exact venue, preparation ID, current native snapshot hash, current draft ID or null, subject and body. |
| Same operation — `review`                      | Exact venue, draft ID, content hash and current native snapshot hash.                                  |

The loopback fixture exposes the same strict action union at
`/dev-fixtures/prospect-research/sales`, not an arbitrary RPC proxy. Caller-supplied
actors, extra fields, sender actions and incomplete review identity are rejected.

`readNativeSalesSnapshot` bounds contacts, sources, import lineage, threads and
messages. Exceeding a bound fails visibly rather than silently truncating evidence.
Dates are exact ISO strings; the canonical snapshot hash covers native source,
contact, thread and provider state. Derived preparations, drafts and review activity
do not themselves alter that underlying source snapshot.

## Original component bridge

`scripts/crm-sales/component_bridge.py` reads JSON from stdin and writes JSON to stdout.
It imports the original vault implementations in place: Research Gate, Outreach
Composer, Correspondence Engine, Write Like Tom and Approved Language. It does not
copy or rewrite them. The subprocess has no database/provider credentials, no shell,
no network sockets and no database writer. The server bounds time, input and output.

The bridge supports `evaluate`, `prepare` and `check`; `catalog` is a read-only local
acceptance helper. No sender action exists.

### Source crosswalk

An accepted component prospect is matched only by the original workbook SHA-256,
sheet, original row and every source cell. The only declared comparison normalization
is null versus empty string between the two original workbook adapters. Both original
raw-row hashes are retained separately. Venue, organization, import record, native
evidence, native contact where present, component prospect and component routing IDs
remain distinct and are bound in the resulting preparation.

The existing component contracts currently admit five exact records: P01, P02, P03,
P06 and P08. Other native prospects still receive a real bounded Research Gate
evaluation, but no invented Composer identity. They show research/human questions and
a visible missing-crosswalk blocker. No research is automatically executed.

The native email-readiness/permission state stays UNKNOWN. Public-route evidence is
a retained source snapshot, not a contact update or a Tom-selected verified recipient.
A form remains a form: native draft email and contact are null, and no form submission
is available. A public email different from the imported candidate retains a null
native contact binding and is subject to native address-wide suppression checks.

### Research, WLT and language

The original Gate supplies ENOUGH_EVIDENCE, RESEARCH_REQUIRED or HUMAN_INPUT_REQUIRED
and exact questions bounded to the current review-only task. Component/source/policy
code hashes, research snapshot, WLT request/result/packet identity and Approved Language
snapshot are bound to each preparation. No live website executor is installed.

The actual Approved Language library had **zero approved entries** at acceptance.
No candidates were promoted, no synthetic phrase entered the real path, and no approved
sentence was manufactured. The native route works with zero selected language entries.

The original Composer prepares the writing context; this slice deliberately leaves
the actual writing to the operator/writer. `check` binds exact subject/body bytes and
runs the original WLT check plus bounded risk/transcript checks. It does **not** claim
full Composer claim-annotation or semantic-meaning validation. Such review remains
required and visible. “Reviewed” means an exact operator read-review receipt, not
semantic certification, Tom approval or SEND_AUTHORIZED.

### Exact bytes and revisions

The native source-evidence JSON holds a `torchiko.native-component-storage/1` envelope
containing exact `componentJson` UTF-8 bytes and SHA-256. This avoids a real round-trip
bug found during acceptance: nested WLT floating-point rankings were rounded by the
JSONB/Prisma path. Legacy failed snapshots were retained, are explicitly unusable and
cannot provide current preparation authority. No failed evidence was deleted or edited.

Distinct hashes are not interchangeable: native source hash; native draft content hash;
Composer hash of `Subject: <subject>\n\n<body>\n`; WLT body-only hash; research/WLT/language
file hashes; and the exact component-storage hash. Native revision series include
venue, routing, mode, thread and latest inbound identity. Changed subject/body/context
appends a revision; identical content under the same current identity is idempotent.

Writes re-read native state inside Serializable transactions. Stale source/thread,
changed component/library/WLT heads, stale draft ID, mismatched body hash or suppression
fail closed. Reviewed text is never overwritten. Database constraints/triggers prevent
turning these revisions into approval, frozen recipients or delivery.

## Synthetic correspondence

`admitSyntheticSalesThread` is a local acceptance helper, not an HTTP endpoint. It
accepts explicitly SYN-prefixed identities on a disabled FAKE account with empty
capabilities, no credentials/cursor and delivery disabled. It reuses native thread,
provider mapping and message owners. Complete message IDs, provider IDs, references,
timestamps, bodies and native scope must reconcile. Re-read is zero-write/idempotent;
changed content under a provider/message ID, changed thread ownership, omitted existing
messages and stale native snapshots are rejected.

The bridge produces an explicitly synthetic correspondence snapshot while preserving
real source/WLT/language provenance (`source_mode: real`). The actual reducer identifies
the latest inbound and live points; the actual Correspondence Composer binds an
operator-supplied response direction to those points. Neither reducer projections nor
fixtures create a human inbound-review classification. Reply revisions carry exact
thread/snapshot/latest-inbound identity and remain separate from the email chain.

Historical outbound `SENT` in the fixture is visibly synthetic data, not a delivery
operation. Exactly two such synthetic historical messages exist; no real correspondence
was imported or sent. No Gmail, SMTP, network research or external form call occurred.
