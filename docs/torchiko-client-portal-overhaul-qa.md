# Torchiko Client Portal Overhaul: QA and Change Record

Date: 2026-08-19
Mission source: `Torchiko_Client_Portal_Onboarding_Experience_Overhaul_Codex_Prompt(1).md`
Architecture: `docs/torchiko-client-portal-overhaul-plan.md`

## Outcome

The client experience is now organized around one current state and one useful next action. The old stack of equally weighted rounded panels has been replaced by an editorial shell, a five-stage journey rail, a compact material workbench, and a restrained Torchiko convergence core. Existing lifecycle, upload, support, preview, publication, auth, and tenant boundaries remain authoritative.

## What changed

- Rebuilt the Ultra Simple Portal around **Today**, one lifecycle-led focal field, one primary task, and a small set of live essentials.
- Simplified client navigation and added a persistent **Information** destination so setup can recede after launch.
- Rebuilt onboarding as **Welcome → Share → Processing → Questions → Ready** while retaining exact resume anchors and progressive access to detailed review/readiness evidence.
- Replaced the native-looking upload presentation with an accessible input-backed drop field, automatic or manual material classification, safe previews, multi-file sending, byte/percentage progress, pause/cancel/retry/remove actions, explicit duplicate/invalid states, compact category filtering, and the existing 50 GB venue cap.
- Hid empty question sections and linked real questions to their exact support request and return location.
- Reworked loading, error, empty, completion, venue-creation, and initial workspace states.
- Reworked the shared client shell and support surface without changing admin workflows.
- Added semantic Torchiko tokens and reusable `TorchikoCore`, `ClientJourneyRail`, `PortalPrimaryAction`, and `ClientSectionHeading` primitives.
- Fixed the exact-preview boundary so a superseded package can never produce a client preview link.

Removed from the primary experience: six-step-style setup clutter, giant empty question/readiness panels, repeated onboarding detail, equal-weight bubble cards, redundant category selection, operational jargon, and a misleading retry action for duplicate or structurally invalid files.

One runtime dependency, `hash-wasm`, was added for incremental client-side SHA-256 over chunked
large files. That avoids reading a multi-gigabyte file into memory before resumable upload and is a
transport-integrity dependency, not a visual-design dependency. The signature visual and motion
use existing React, SVG, CSS, and Lucide only. Three.js, WebGL, Framer Motion, and a dropzone
dependency were intentionally not added because they would increase bundle/GPU/maintenance cost
without improving the task.

## Important implementation files

- `apps/dashboard/components/DashboardShell.tsx` — responsive client navigation and compact admin-view bridge.
- `apps/dashboard/components/DashboardOverview.tsx` — Ultra Simple Portal Today experience.
- `apps/dashboard/components/RemoteOnboardingJourney.tsx` and `RemoteOnboardingJourney.module.css` — five-stage onboarding composition and progressive detail.
- `apps/dashboard/components/IntakeFileUpload.tsx` and `IntakeFileUpload.module.css` — real upload transport adapter, workbench, queue, previews, progress, error recovery, and material library.
- `apps/dashboard/lib/intake-file-identity.ts` — bounded incremental SHA-256 and stable upload identity for large resumable files.
- `apps/dashboard/components/TorchikoCore.tsx`, `ClientJourneyRail.tsx`, `PortalPrimaryAction.tsx`, `ClientSectionHeading.tsx`, and `TorchikoClientPrimitives.module.css` — shared visual, motion, journey, action, and heading primitives.
- `apps/dashboard/components/SupportWorkspace.tsx` — client question and response presentation.
- `apps/dashboard/app/(app)/information/page.tsx` — persistent post-launch information workspace.
- `apps/dashboard/app/(app)/venues/[venueId]/onboarding/*` and `apps/dashboard/app/(app)/loading.tsx` — production route composition and route states.
- `apps/dashboard/app/dev-fixtures/*` and `apps/dashboard/lib/middleware-access.ts` — development-only deterministic visual-state matrix and access boundary.
- `apps/dashboard/public/torchiko-logo.svg` and `packages/ui/src/PathFinderBrand.tsx` — canonical client brand asset and compatible shared renderer.
- `docs/torchiko-client-portal-overhaul-plan.md` and this file — architecture, decisions, QA evidence, limitations, and founder acceptance checklist.

## Infrastructure improvement

The repository previously had only one incomplete onboarding fixture and no repeatable visual state matrix. Development-only fixtures now render production components from real lifecycle/projection contracts:

- `/dev-fixtures/remote-onboarding?state=welcome|share|processing|questions|ready`
- `/dev-fixtures/portal-home?state=live|paused`
- `/dev-fixtures/upload-states?state=selected|uploading|error|joined`

`/dev-fixtures` indexes the matrix. The routes call `notFound()` outside development, and middleware only makes the tree public in development. They never read or mutate client data. Future sessions should start the dashboard development server, open the index, and review every state before accepting portal visual changes. The fixture infrastructure itself requires no new dependency or maintenance service.

## Visual critique and iteration

First rendered pass, 982 × 1272:

- The convergence core was distinctive and the material workbench was dramatically clearer.
- The onboarding page repeated its materials heading and left too much air before the workbench.
- The portal core occupied too much of a tablet/desktop viewport.
- The mobile journey rail design could hide later stages off-screen.
- Duplicate/invalid files inherited the network-error retry treatment.

Second pass:

- Removed the duplicate heading and tightened the hero-to-workbench rhythm.
- Moved the portal to a two-zone composition at tablet width and reduced the small-screen core.
- Made all five journey stages fit within the mobile width rather than relying on horizontal scroll.
- Gave invalid/duplicate selections a terminal removable state while preserving retry for recoverable transport errors.
- Added an `h1` contract to the persistent Information page.

Final state pass:

- Added deterministic selected, uploading, recoverable-error, and joined upload fixtures around the real production component.
- Coupled the material strand to actual queue phases: it settles when files are selected, moves only while bytes are being sent, and resolves calmly after the handoff. Reduced-motion users receive the same state without animation.
- Replaced the ambiguous queue heading with phase-aware language: **Ready to share**, **Sending to Torchiko**, **A file needs attention**, and **Handoff complete**.
- Removed the disabled Upload control from an in-flight item so the only available action during transfer is the truthful **Cancel upload** action.
- Tightened the phone composition: a smaller focal visual, readable five-stage labels without redundant micro-status text, and compact two-column material filters whose explanatory descriptions recede on narrow phones.

Rendered states inspected in a real Chromium browser: onboarding Welcome, Share, Processing, Questions, and Ready; upload Selected, Uploading, Error, and Joined; and portal Live and Paused. The browser's supported viewport override was used at 390 × 844, 768 × 1024, and 1440 × 1000. Across all 33 state/viewport combinations, the rendered document had no horizontal overflow, duplicate IDs, unlabeled interactive controls, or broken images. At 390 × 844, every onboarding primary action and both portal actions appeared within the first viewport. Browser diagnostics contained no runtime errors; the only warnings were Clerk's expected local development-key warning.

Current rendered evidence is retained in `docs/evidence/torchiko-overhaul-*`: mobile Welcome, Questions, upload Selected, and portal Live at 390 × 844, plus desktop Questions at 1440 × 1000.

The authenticated FloorSteakVenue route was also inspected at 390 × 844 with the production client shell. Its header, compact admin-view bridge, primary action, living core, and all five journey labels fit without horizontal overflow. Opening the mobile drawer locked background scrolling, moved focus to the first navigation item, retained a visible close control, and introduced no overflow. The route had one `main`, one `h1`, no duplicate IDs or broken images, and no browser error; only Clerk's expected development-key warning was present.

## Accessibility and responsive behavior

- Real input, button, link, list, heading, navigation, status, alert, and progressbar semantics are retained.
- Drag/drop is progressive enhancement over the labeled multiple-file input.
- Multipart progress exposes a named determinate progressbar and polite live status; verification never invents a percentage.
- Meaning is not color-only; stages and upload states include text, shape, and icons.
- Focus treatments and practical 44 px targets are built into the new controls.
- The five-stage rail remains fully visible at the mobile media query.
- Motion uses transform/opacity/SVG stroke only. `prefers-reduced-motion: reduce` removes line drawing, pulse, drift, rotation, and loading animation while leaving complete static visuals.
- Component axe gates pass. A real-browser computed-color audit caught light-surface text between approximately 1.5:1 and 4.3:1 that jsdom axe could not detect; those tokens were separated by surface and darkened. The same audit was then rerun on Questions, upload Selected, and portal Live at 390 × 844, 768 × 1024, and 1440 × 1000 with zero remaining failures. The lowest passing rendered text was 4.57:1 in the desktop/tablet journey state, 4.9:1 in the narrow onboarding body, 5.67:1 in upload, and 5.32:1 in portal; the corrected upcoming-step marker measured 5.4:1.
- A final 390 × 844 hit-target pass caught the upload queue category selector at 32 px. It now remains at least 44 px high, is contract-tested, and the rendered Error fixture has zero interactive controls below 44 × 44 after excluding native radio inputs whose wrapping labels supply the larger target.

Outstanding physical-device evidence is now limited to behavior that a desktop viewport override cannot prove: iOS/Android native file-picker and camera-source behavior, touch feel, and OS-level reduced-motion behavior in a device browser. The responsive 390 × 844 layout itself has current real-browser evidence.

## Performance

- One focused runtime dependency (`hash-wasm`) supports incremental large-file upload identity;
  there are zero new visual/motion/dropzone/3D dependencies, raster hero assets, WebGL systems,
  continuous particles, or visual-state fetches.
- Both the modern `File.stream()` path and its compatibility path hash incrementally; the fallback
  uses bounded 8 MB `Blob.slice()` reads and is regression-tested never to call whole-file
  `arrayBuffer()` for large media.
- Production manifest inspection confirms the hashing chunks are attached to intake-capable
  Information/onboarding routes and are absent from the Ultra Simple Portal home route.
- The optimized dashboard build completed. Shared first-load JavaScript is 186 kB; `/` is 259 kB, `/venues/[venueId]/onboarding` is 292 kB, and `/information` is 290 kB in the current dirty implementation tree.
- The SVG/CSS visual animates compositor-friendly properties and has a static reduced-motion state.
- Existing Sentry/OpenTelemetry dynamic-require and webpack cache warnings remain; they are not introduced by this client overhaul.

## Verification evidence

### System Super regression, 2026-08-19

The complete portal/onboarding redesign was re-run after the Client Tochi and Venue Bot Character integration. The full dashboard suite passed 708 tests, the browser-foundation dashboard set passed 125 tests, and the dashboard axe set passed 5 tests. A real authenticated mobile/desktop sweep again found no overflow, duplicate IDs, broken images, or browser console errors. During this regression the materials anchor was changed from a duplicate named region to a non-landmark wrapper, preserving `#materials` while leaving the upload workbench as the single “Share venue materials” region. The broader System Super evidence is in `docs/TOCHI-QA.md`.

Passed:

- `pnpm --filter @pathfinder/dashboard test` — 708 passed on the final worktree.
- `pnpm test:browser-foundation` — dashboard 125 tests and guest 61 tests; the runner includes the onboarding journey, shared primitives, Client Tochi states, and public Character presentation.
- `pnpm test:accessibility` — dashboard 5 and guest 2 axe contracts.
- Focused portal/onboarding/upload/support suite — 65 tests.
- Client primitive motion/responsive contract — 4 tests, including explicit mobile five-stage layout and reduced-motion CSS coverage for the convergence core and upload handoff.
- Focused API portal, support-resume, upload, and generated cross-tenant suite — 111 tests.
- `pnpm typecheck` — all 23 workspace tasks.
- `pnpm lint` — all 13 workspace tasks; one existing `PlaceCard` image optimization warning remains.
- `pnpm --filter @pathfinder/dashboard build` — optimized production build completed.
- `pnpm test:scripts` — 153 passed, with one intentionally skipped historical migration fixture.

The first full-workspace run exposed a pre-existing admin-router modularity breach. Client reads, evaluation onboarding reads, and evaluation review/cancellation actions were split into bounded domain routers; the exact public procedure inventory was pinned and preserved. API typecheck/lint and the full workspace suite passed after the split.

The environment-guarded 15-step remote-onboarding integration was rerun on a fresh loopback-only
`pgvector/pgvector:pg16` container after all 110 migrations were applied. It passed the sanitized
invitation → intake → verification → review → exact support resume → preview → evaluation →
readiness → apply → rollback lifecycle, and the exact disposable container was removed and verified
absent afterward.

## Local-staging publication

`pnpm local-staging:up` rebuilt and restarted the existing local stack. Post-publication evidence:

- dashboard `http://127.0.0.1:3101/sign-in` returned 200;
- phone/LAN dashboard entry `http://192.168.7.31:3101/admin` is bound through the managed local-staging host;
- web health `http://127.0.0.1:3100/api/health` returned 200;
- PostgreSQL, Redis, MinIO, and ClamAV reported healthy;
- presigned intake storage now resolves to `http://192.168.7.31:59000` rather than phone-local
  `127.0.0.1`; only that MinIO API port is LAN-bound, while its console and every privileged
  dependency remain loopback-only;
- the exact phone dashboard CORS preflight returned 204 with the requested `PUT`, `content-type`,
  and `x-amz-checksum-sha256` admission;
- an unsigned LAN `PUT` was rejected with 403, and a preflight from an unrelated origin received
  no `Access-Control-Allow-Origin` header;
- nine live LAN-endpoint integration cases wrote, read, checksum-verified, malware-scanned, and
  removed synthetic PDF/image/media and resumable multipart-video objects;
- the authenticated Admin attention view loaded with real tenant/venue state;
- the existing FloorSteakVenue onboarding route rendered the redesigned Processing state, three saved materials, real review evidence, compact admin-view notice, and exact venue-scoped support link.
- the local dashboard stdout/stderr logs were scanned after exercising the fixture and authenticated routes; no `Error:`, `TypeError:`, `ReferenceError:`, unhandled exception, fatal error, or failed-compilation entry was present. The only recurring stderr output was the already-documented OpenTelemetry/Sentry dynamic-require warning and normal development Fast Refresh notices.

The public `verify:staging-health` and `verify:staging-widget` commands were not used as local-health claims: those admission tools correctly require an HTTPS host, exact release revision, and independently confirmed public staging resource identifiers. Local publication was instead verified with the local-staging status contract and direct local endpoints.

All local client data is rooted at `C:\Users\tomsc\PathFinderLocalStaging`; stopping the managed
stack preserves it. This is the requested PC-local interim storage boundary, not an assertion of
durable cloud retention.

## Definition-of-done reconciliation

- Existing onboarding, uploads, client data, authentication, tenant isolation, support resume, exact preview, apply, and rollback behavior passed their component/API contracts plus the fresh guarded 15-step lifecycle.
- Onboarding and the Ultra Simple Portal were substantially recomposed around one current status/action, materially less primary-screen detail, a five-stage journey, persistent Information, and restrained editorial fields rather than a stack of bubble cards.
- The coherent Torchiko system uses the real logo, shared deep/mist/aqua/ember tokens, a stateful convergence core, directional journey movement, upload handoff motion, purposeful success/error transitions, and static reduced-motion equivalents. 3D was intentionally omitted because it added cost without improving the task.
- The upload experience has drag/drop and browse parity, mixed multiple files, manual/automatic categorization, live byte progress, cancel/retry/remove, duplicate handling, saved-library filtering, safe previews, resumable multipart transport, and the bounded 50 GB venue policy requested by the founder.
- Welcome, Share, Processing, Questions, Ready, Live, Paused, loading, empty, upload-active, recoverable-error, completion, and route-error states were tested and visually inspected at mobile, tablet, and desktop widths.
- Current browser inspection found no horizontal overflow, broken images, duplicate IDs, unlabeled controls, failing text contrast, or runtime console errors; a dedicated critique-and-iteration history is retained above rather than inferred from final source.
- The primary visual is a production SVG/CSS Torchiko composition, not placeholder-only content. Final subjective brand approval remains the founder’s judgment, while the implementation and current screenshot evidence satisfy the packet’s executable criteria.

## Founder review checklist

1. On a phone, create a disposable venue from Admin and open its client onboarding link.
2. Upload at least a PNG, PDF, short video, and an intentional duplicate; confirm category counts and file filtering.
3. Leave and return; confirm saved upload/journey state resumes.
4. Open a focused question and confirm the exact return to `#questions`.
5. Confirm a real reviewed preview opens only for the available exact package.
6. Review the Live and Paused portal states and the persistent Information page.
7. Turn on reduced motion at OS/browser level and confirm the experience remains complete and calm.
