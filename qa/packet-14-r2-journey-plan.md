# Packet 14 M5 R2 journey plan

Status: run after this Packet 14 branch is rebased onto the published R2 commit and its portal/CRM routes are present. This is a plan, not evidence of a run. Use only the disposable Packet 14 stack, synthetic records, and loopback services.

## Before browser runs

- Confirm the exact R2 SHA and record it with `local:status`; verify DB name, process/listener ownership, loopback bind, network guard and Playwright request allowlist. Use web `127.0.0.1:56345`, dashboard `:56346`, provider `:56344`, MinIO `:56342`, ClamAV `:56347`. Do not connect to hosted services.
- Use fresh browser contexts per identity and viewport. Sign-in uses the fixed labels `Platform admin`, `Tenant A owner`, `Tenant B owner`. Run each applicable journey at 390×844 and 1440×900 three times; retain timing JSON, screenshots and Playwright trace under this task's `qa/` only.
- The existing synthetic venue contract is Tenant A `aurora-science-museum` / `cpacket14aurora0000000000`, `pocket-collection-museum`; Tenant B `riverbend-nature-centre`. Verify exact R2 seed readback before asserting IDs or UI text.

## Visitor speed and protected access

1. Open the Aurora guide in an anonymous context. Send two questions in one session, with a new context for first-turn samples. Assert a pending indicator appears within 300 ms; each NDJSON response has `no-store`, delta event(s), and terminal `complete`; record click-to-first-visible-words, `providerFirstTextMs` and `requestFirstTextMs` from the first delta. For a >40-word answer, sample assistant text length on each animation frame and require at least three distinct increasing visible stages. Record completion time, event types and answer word count. Read matching synthetic `message.received` analytics from the disposable DB for `turnSetupMs`, `preEmbeddingMs`, `embeddingMs`, `retrievalMs`, `promptAssemblyMs`, `modelMs`, `persistenceMs`, `totalMs`, `providerFirstTextMs`, and `requestFirstTextMs`; correlate by synthetic turn/session, and leave absent fields blank rather than infer them from browser timing.
2. At both widths, sign in as Tenant A owner in the dashboard, confirm Home identity and tenant venues, then make a same-browser-context request to web `venue.getById` for `cpacket14aurora0000000000`. Verify the dashboard cookie is present for the web host but web resolves anonymous and returns `UNAUTHORIZED`; retain status/body excerpt without cookie value. Sign out; sign in as Tenant B, assert only Riverbend is listed, A venues are absent, and dashboard `venue.getById` for A returns `NOT_FOUND` with no venue details.
3. If synthetic analytics can be seeded deterministically, add known `requestFirstTextMs` samples inside seven days and assert the admin speed page's per-venue count/p50/p90 against hand-calculated values; include out-of-window, null and invalid values to verify exclusion. If seed or route is absent, mark the readout blocked/pending R2; do not manufacture a pass from browser timings alone.

## Authenticated CRM review

1. Sign in as Platform admin; open the R2 CRM Good fit view. Seed only synthetic disposable prospects covering a right-sized fit, XL stadium-type exclusion, contacted/campaign/duplicate/enterprise exclusions, unknown size, and identity/row-version/geography conflict cases. Assert the visible fit reason and size confidence for each included row; XL and blocked candidates are excluded or explicitly explained.
2. Upload a synthetic proposal file. Assert exact-ID matching and diff against current seeded values; show identity, geography and changed-row-version conflicts without applying those rows. Select one non-conflicting fixture row, apply through the native audited writer, then read back the changed value and matching audit actor/event. Reset only via the lane-owned reset after preserving the test receipt.
3. Do not use Packet 7's staged 242-row proposal pool as live CRM data. The handoff reports 130/242 classed, a failed 80% gate, 14 identity holds, and unknown live priority/territory/correspondence/duplicate fields. Actual CRM counts and Tom's later apply session remain outside this synthetic proof.

## Client portal save, preview and upload

1. Sign in as Tenant A owner. On Home, verify the synthetic guide link and QR target the same Aurora URL, with the QR source query `?source=qr`. Navigate to R2 `/look-and-feel`; record final nav labels and accessible selectors because these can change during R2 integration.
2. Change all four independent visitor/text colours and bubble style. Assert contrast correction matches the saved/rendered value, save, reload, and verify persistence from the disposable DB. Assert the embedded preview renders those saved values in the real visitor renderer and the appearance-preview frame; verify no chat/model request or analytics event occurs. On phone, switch Edit/Preview tabs and verify preview is reachable without horizontal overflow.
3. Upload a generated, harmless valid synthetic image through the portal. Assert reservation → MinIO write → ClamAV verification → BRANDING Help request, attached verified file, visible “In review” state, and pending local preview labelled unapproved. Assert the visitor's published media remains the old approved image until a separate synthetic operator applies it; test invalid type/oversize rejection. Do not upload personal or production imagery.
4. If Help upload/send is in scope for the R2 contract, force one local verification/send failure, confirm draft and attachment remain, retry once, and assert exactly one request/message with the verified attachment.

## Evidence and limits

- Save per-run JSON with exact R2 SHA, viewport, synthetic venue selector, first-word/phase values, delta/paint counts, expected/actual CRM readback and upload state transitions. Save responsive screenshots and traces with no cookies, credentials, real contact data or hosted records. Confirm browser requests and launcher logs show loopback destinations only.
- Packet 14 can prove the application auth/tenant policy, visitor protocol and timing on its synthetic DB/provider, local CRM workflow, portal persistence/preview, and local object/scanner pipeline. It cannot prove Clerk token verification, hosted streaming/cold starts or Railway buffering, live CRM fit/coverage, production image application, iOS/physical-device behavior, or Tom's approval. Packet 2 staging/production targets require their separate admission and authorization gates; no synthetic result substitutes for them.
- Resolve after R2 lands: exact Good fit and speed routes/locators, sample-data fixture mechanism and expected p50/p90, CRM proposal upload control/shape, Look & feel field labels/save state, media upload selector/limits, preview frame URL/labels, and whether R2 exposes audit readback to the synthetic admin journey. Update this plan with observed selectors and seed IDs before running; keep unknowns marked until verified.

## Source handoffs

- Packet 14 acceptance and port/seed contract: `docs/local-full-stack.md`.
- Packet 7 local review/apply proof, failed size-coverage gate and Tom-only live apply: `PACKET-7-HANDOFF.md` in AwesomeVault's Torchiko Program 2026-09-27 staging folder.
- Client portal behavior and fixture-only limits: `C:/Users/tomsc/MachineWorkspaces/torchiko/20260927-client-portal-redesign/HANDOFF.md`.
