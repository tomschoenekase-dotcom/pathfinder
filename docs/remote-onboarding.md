# Remote onboarding

Torchiko's remote onboarding home is a unified client-safe projection over existing durable venue
facts. It does not own a second copy of uploads, evidence, packages, deployment, or publication
state.

## Client journey

The authenticated route is `/venues/[venueId]/onboarding`. `portal.getOnboardingJourney` first proves
the exact tenant/venue scope and returns bounded durable projections for materials, processing,
review, client questions, the exact approved-package preview, seven-dimension QA, readiness, and
release state. The page keeps material upload as the obvious starting action, then progressively
discloses website/staff knowledge capture, cited review and versioned corrections, focused support
questions, visitor preview/feedback, and readiness. It cannot approve, publish, deploy, or mutate a
release.

Material cards cover website, documents/PDFs, photos, video/audio, maps/floor plans, FAQs, staff
interviews, and other sources. Files are explicitly tagged, quarantined, verified by immutable object
identity, and shown by category with bounded pagination. Media files may be up to 2 GiB each; the
venue-wide intake allowance is 50 GiB. Non-media files remain capped at 100 MiB and a request may
reserve at most 20 files. Large uploads use replay-safe multipart initiation, part signing,
completion, cancellation, and ambiguous-response recovery against the existing object-storage
boundary.

The review surface exposes client-safe evidence references and appends corrections with optimistic
concurrency. Questions reuse `AgentQuestion`, scoped support participants/messages, and
`OnboardingQuestionLink`; an accepted client answer claims and resumes the exact blocked run at most
once without creating approval. Preview feedback is durable and bound to the exact approved package.
Readiness reports fact, navigation, accessibility, safety, multilingual, adversarial, and
unanswerable outcomes separately; it never collapses release authority into a score.

The portal shell is intentionally reduced to Materials, Support, and Account while the client is in
onboarding. The legacy `/venues/[venueId]/intake` route redirects to this canonical workspace. A
tenant with no venue sees one venue-name field, then lands directly in the materials workspace; the
old multi-step DIY setup is retired.

Website, staff-questionnaire, and optional-note forms retain their independent unfinished state
while the client switches among those source types. Staff answers are also retained separately per
selected role, so inspecting another questionnaire does not erase earlier answers. A page-exit
guard asks the browser to warn when any source still has unfinished input, and only a confirmed
successful submission clears that source's draft. Failed and ambiguous submissions keep both the
input and exact request identity for safe retry.

This is deliberately current-page recovery, not durable server storage: unfinished input is not
written to local or session storage, and private interview text is not persisted in the browser.
Browser exit warnings are best-effort, especially on mobile, so the interface states plainly that
unfinished entries are not saved until shared. Durable cross-device drafts remain an unresolved
product/privacy decision rather than an implied capability.

Submitted work resumes from durable venue state. Remote-onboarding projection version 2 marks the
current primary action as required or optional, so clients and authorized automation can distinguish
a real question, failed material, or preview request from informational progress. Once at least one
source is recorded and no action is required, the journey says that the client can leave and return
instead of repeatedly asking for another source. The page also shows a saved checkpoint and counts
website, staff-answer, optional-note, and file sources consistently. Unsubmitted form entries remain
outside that saved count and retain the current-page-only boundary above.

Loading and error boundaries live beside the route. A sanitized development-only fixture is
available at `/dev-fixtures/remote-onboarding`; both middleware and the route reject it outside
development.

## Client-question resumption

An operator can route a pending blocking `AgentQuestion` to one active tenant member from the venue
agent workspace. `OnboardingQuestionLink` binds the exact question, expected question revision,
support request, initial recipient, answering support message, and resume time.

The support request is operator-created and client-visible only to explicitly active participants.
The assigned recipient can add an active teammate to that exact onboarding discussion. A client
response is claimed under an advisory lock and compare-and-set checks; it answers the exact question,
queues only the matching `AWAITING_INPUT` run, appends agent timeline/message and audit evidence, and
uses a stable redispatch key. A replay of the same message is safe. A different late answer conflicts.

No approval is created or inferred. Publication remains under the existing package and native-release
controls.

## Operator triage

AI Operations labels onboarding-linked support items as `Onboarding blocker` and links to the scoped
support request and blocked agent inbox. Payloads, messages, and recipient identities remain outside
the cross-tenant attention projection.

## Verification

Run the ordinary workspace gates:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm test:accessibility
pnpm test:browser-foundation
```

The database integration proof is opt-in and refuses any non-loopback or non-disposable database:

```powershell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:PORT/pathfinder_disposable_NAME'
$env:DIRECT_DATABASE_URL = $env:DATABASE_URL
$env:RUN_ONBOARDING_QUESTION_DB_INTEGRATION = '1'
pnpm --filter @pathfinder/db exec vitest run src/helpers/onboarding-question-disposable.integration.test.ts
```

The full remote-onboarding lifecycle proof has a separate explicit guard and covers invitation,
website/interview/file intake, verification, cited review, question/answer/exact resume, immutable
FULL-base and PATCH manifest linkage, package approval, preview feedback, the frozen seven-dimension
evaluation, transparent readiness, explicit apply, and rollback:

```powershell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:PORT/pathfinder_disposable_NAME'
$env:DIRECT_DATABASE_URL = $env:DATABASE_URL
$env:RUN_REMOTE_ONBOARDING_E2E_DB_INTEGRATION = '1'
pnpm --filter @pathfinder/api test -- remote-onboarding-disposable.integration.test.ts
```

Ordinary Vitest setup continues to force the synthetic test database unless this exact flag is set;
`vitest-setup-boundary.test.ts` protects that separation.

Use the repository's guarded disposable migration wrapper before the integration proof. Never point
these commands at staging or production.

## Deployment status

Source, local tests, browser evidence, and a fresh disposable migration are not deployment evidence.
All onboarding migrations must be reviewed and applied through the authorized release process. No
remote staging or production state is claimed here. Local filesystem/MinIO configuration is suitable
for a controlled local pilot only; durable client-data hosting still requires an approved cloud
object-storage and retention design.

The managed local pilot stores PostgreSQL, Redis, MinIO objects, scanner data, logs, and process
state under `C:\Users\tomsc\PathFinderLocalStaging`. `local-staging:stop` stops services but
preserves that directory. At startup, the script resolves the PC's active default-gateway IPv4
address and publishes only the MinIO S3 API on that address so a phone using the LAN dashboard gets
a reachable presigned upload URL. PostgreSQL, Redis, ClamAV, and the MinIO console remain bound to
loopback. This is a same-LAN development bridge, not cloud hosting or an Internet exposure model.

## Sales-to-onboarding bridge

The platform-admin `/admin/new` flow now collects the client name, first venue, and primary client
contact together. The request hash includes the normalized contact and role. After the fenced Clerk
organization and local tenant/venue creation complete, the server ensures one matching pending
organization invitation. A retry reuses the exact case-insensitive pending invitation; an existing
pending invitation with another role fails closed. After setting the exact impersonated tenant, the
operator lands on `/venues/[venueId]/onboarding` rather than an unscoped dashboard.

Legacy collection, support, and preview links may still carry an exact, same-venue `returnTo` value.
Every receiver validates the venue and allowlisted destination before rendering a return link;
external, cross-venue, malformed, oversized, and unknown values fall back safely.

This code does not authorize sending a real invitation. A real invite requires the reviewed release
to be deployed with the intended Clerk instance and the external database incident stop to be
lifted through its documented review process.

## Local visual test surface

For a safe local review that performs no authentication, provider call, client contact, or release
mutation, start the dashboard in development and open:

```text
http://127.0.0.1:3001/dev-fixtures/remote-onboarding
```

The fixture is middleware- and route-rejected outside development. It exercises the production
journey component with sanitized data, but it is not evidence that Clerk invitation delivery or a
staging deployment works.
