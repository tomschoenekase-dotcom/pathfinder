# Torchiko Client Portal + Onboarding Overhaul Plan

Status: implementation-ready
Date: 2026-08-19
Scope: `apps/dashboard` client portal and remote onboarding only; admin operations and backend workflow contracts remain out of scope unless a shared client boundary requires a narrowly documented change.

## Reconnaissance summary

The latest mission packet is `Torchiko_Client_Portal_Onboarding_Experience_Overhaul_Codex_Prompt(1).md`; it is a strict, newer superset of the earlier copy. The current product already has strong tenant/auth boundaries, truthful lifecycle projections, resumable multipart uploads, recoverable verification states, and question/support routing. The problem is primarily the client-facing hierarchy and presentation: the current phone captures show an oversized shell/banner, long stacks of equal rounded panels, a native-looking file control, weak visual focus, and an onboarding page that exposes too much review/readiness detail at once.

Relevant existing assets and infrastructure:

- `public/torchiko-logo.svg` and `@pathfinder/ui` already provide the current Torchiko identity.
- Plus Jakarta Sans, Tailwind, Lucide, Vitest, Testing Library, axe-core, local staging, and the in-app browser are already present.
- `RemoteOnboardingJourney`, `DashboardOverview`, `DashboardShell`, `IntakeFileUpload`, and `SupportWorkspace` preserve the production data and mutation boundaries that the redesign must use.
- The current dev fixture exposes only one onboarding state and is insufficient for repeatable visual QA.
- There is no owned end-to-end browser-test framework. Playwright appears only as an optional/transitive dependency, so this change will not pretend that jsdom tests are browser tests.

The brand archive establishes a light, warm, human, premium-hospitality direction; the convergence/direction motif; purposeful motion; and a strong prohibition on generic “rounded cards + gradients + bubbles” composition. The newer mission packet and current logo add a restrained warm flame/arrow tip. The implementation will reconcile these by treating the visual as an abstract convergence core with a small warm directional ember—not a literal torch, campfire, or gamified mascot.

Primary technical references used in the plan:

- MDN’s file-drop guidance recommends backing a drop target with a real file input so browse/keyboard behavior remains native and accessible: <https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop>
- W3C’s file-upload progress technique requires explicit progress semantics plus a polite live status message: <https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA25>
- Reduced motion will use the platform preference rather than a second JavaScript motion system: <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion>

## Information architecture

The client portal will answer, in order: what Torchiko is doing, whether the client must act, and where to add information or ask for help.

- **Today** (`/`): one current status, one primary action, a restrained living convergence visual, and at most a short secondary activity/support path. Live-only operational tools appear after the core state.
- **Your information** (onboarding materials anchor while collecting; the same destination remains the contribution surface later): source categories, upload/add material, and already-shared material.
- **Setup** (only prominent before live): a five-stage client-language journey—Welcome, Share, Processing, Questions, Ready.
- **Questions** (`/support` with exact request/return context): only present when input is needed; no giant empty placeholder.
- **Help & changes** (`/support`): one human destination for help, corrections, and requested changes.

The navigation shell will use these client concepts instead of operational feature names during onboarding. Completed onboarding will recede; live clients see Today, Updates, Reports when available, Information, Help & changes, and Account.

## Onboarding architecture

The production lifecycle projection remains authoritative. The UI translates it into a compact five-stage path and a single current-action composition:

1. **Welcome** — venue identity, what happens next, one “Start with what you have” action.
2. **Share what you have** — forgiving material intake, website/staff knowledge as secondary paths.
3. **Torchiko is organizing it** — truthful qualitative activity derived from upload/review counts; no fabricated percentage.
4. **A few questions** — exact support requests with brief reasons and direct answer links.
5. **Ready** — reviewed preview/readiness action and clear next outcome.

Detailed source history, corrections, readiness dimensions, and full journey state will remain accessible through progressive disclosure below the primary flow. They will not compete with the first-screen action.

## Visual and motion system

- Predominantly warm-white/cool-mist backgrounds, deep ink/navy type, controlled aqua/blue structure, and a restrained coral/amber directional accent taken from the current mark.
- A composition system based on rails, fields, inset bands, and directional seams—not nested floating bubbles. Standard radii will be modest; only the convergence core and intentional controls are fully rounded.
- Clear type scale: compact eyebrow, expressive but readable display heading, strong section title, plain body, concise metadata.
- Borders indicate controls or real containment only. Depth comes primarily from tonal layers and selective shadow.
- State uses icon + label + text + shape, never color alone.

Signature interactions (four):

1. **Living convergence core:** lightweight inline SVG/CSS strands draw toward the mark; state changes its completeness and tempo.
2. **Directional stage rail:** an ember-tipped path identifies the current onboarding stage and completed stages without constant motion.
3. **Material handoff:** drag/drop focus changes the field, selected items appear as organized rows, and successful real upload state sends a brief strand/pulse toward the core.
4. **Status transition:** portal/onboarding primary content enters directionally and completion settles into the stable mark.

All motion uses transform, opacity, and SVG stroke properties; it is optional to comprehension and becomes a dignified static final composition under `prefers-reduced-motion: reduce`.

## 3D and dependency decision

No WebGL/Three.js and no new motion or drop dependency will be added. The current logo is already a strong vector convergence object, and the needed interactions are achievable with React, SVG, CSS, and native file input/drop events. A 3D runtime would add bundle, mobile GPU, fallback, and maintenance costs without improving the client’s task. Lucide remains the single interface icon family.

Performance budget:

- zero new visual, motion, dropzone, or 3D runtime dependencies; if the existing large-file
  transport cannot hash incrementally with browser primitives, one bounded hashing dependency is
  permitted and must be justified against the 50 GB venue workflow;
- no raster hero asset or WebGL bundle;
- signature visual is inline SVG/CSS and avoids layout-affecting animation;
- no fake timers or continuous particle systems;
- no new client fetches for visual state;
- first-screen mobile visual must not displace the primary action below an unreasonable scroll distance.

## Component architecture

Create small app-specific primitives rather than a new framework:

- `TorchikoCore`: reusable stateful inline SVG visual with reduced-motion-safe CSS.
- `ClientJourneyRail`: five-stage semantic list with completed/current/upcoming treatments.
- `PortalPrimaryAction`: one hero/status/action composition shared conceptually by home and onboarding.
- `ClientSectionHeading` / compact empty or status treatments where reuse is real.
- `IntakeFileUpload`: preserve transport logic; replace presentation with a native-input-backed drop field, category chooser, readable progress, safe image previews, clearer retry/cancel/remove actions, and concise submitted-file browsing.

`RemoteOnboardingJourney` will compose these primitives and existing intake/proposal/correction components. `DashboardOverview` will be rebuilt around one current action and the living core. `DashboardShell` will simplify navigation and the admin-view notice without touching admin routes. `SupportWorkspace` changes will be limited to the client question/input entry points required for visual continuity.

## Responsive behavior

- Mobile: one-column, compact sticky brand bar, primary action before supporting detail, horizontal/compact stage rail, full-width 44px+ controls, no horizontal overflow, and a smaller static/deliberate core.
- Tablet: two-zone primary composition with upload/task content below.
- Desktop: asymmetric focal composition with the core and action sharing the first viewport; secondary detail follows in editorial bands.
- Venue switching remains visible only when multiple venues exist and becomes a compact native select or concise switcher rather than a row of pills.

## Accessibility

- Native landmarks, heading order, list semantics, labels, and real buttons/links.
- File drop is progressive enhancement over a real labeled `input[type=file]`; drag/drop is never the only route.
- Determinate byte progress uses `role="progressbar"` with values and a polite textual live region; indeterminate verification uses status text without fabricated progress.
- Errors remain `role="alert"`, successful/background changes use `role="status"`, and focus is not moved merely to announce progress.
- Visible focus treatments and 44px minimum practical targets.
- Reduced motion removes path drawing, pulse, drift, and large spatial transition while preserving the final state.
- Contrast and meaning will be manually checked in a real browser because jsdom axe cannot validate rendered color contrast.

## Backend and security constraints

- Preserve `portal.getOnboardingJourney`, upload list/reserve/verify/multipart sign/complete/cancel, proposal/correction, support request, preview, and publication boundaries.
- Never infer upload success from animation or storage response; only authoritative mutation state drives success UI.
- Keep request/claim replay identities, tenant scoping, cross-tenant nondisclosure, resumability, 50 GB venue cap, file-count/type/size rules, and server-sanitized errors.
- Client portal cannot approve/release/publish. Admin impersonation remains explicit and reversible.
- No fake client data in production; deterministic fixtures are development-only.

## Testing and visual QA

Focused automated gates:

- expand `RemoteOnboardingJourney.test.tsx` and `DashboardOverview.test.tsx` across welcome/share, processing, questions, preview/ready, live, paused, and no-action states;
- expand `IntakeFileUpload.test.tsx` for drop/browse equivalence, drag state, mixed files, category reassignment, progress semantics, retry/cancel/remove, duplicate communication, preview cleanup, and current resumable behavior;
- retain axe checks and add the new core states;
- run existing portal, tenant-isolation, auth, support-resume, upload, and disposable remote-onboarding integration gates;
- run dashboard typecheck, lint, test, and production build, then full workspace gates.

Reusable development fixtures will expose deterministic portal and onboarding state matrices without changing production data. Visual review targets are 390×844, 768×1024, and 1440×1000 for welcome, empty, selected/uploading, recoverable error, processing, questions, ready, live/returning, loading, and route error. Capture above-fold and full-page evidence where browser tooling permits, check console/failed assets/overflow/focus/reduced motion, critique the first pass, and record the iteration.

## Rollout and risk

- Keep route contracts and mutations unchanged so rollback is a front-end revert rather than a data migration.
- Scope new CSS/classes to client portal primitives to avoid unrelated admin regressions.
- Add fixtures and tests before relying on visual claims.
- Do not remove detailed operationally useful content outright until it is retained behind disclosure or an existing destination.
- If real mobile browser capture cannot be automated safely, use the current physical-device/LAN workflow for final validation and document that evidence honestly.

## Delivery sequence

1. Establish visual primitives/tokens and deterministic state fixtures.
2. Rebuild the shell and Today/home composition.
3. Rebuild onboarding journey and progressive detail.
4. Rebuild upload presentation while preserving transport logic.
5. Align focused questions/help entry points and route states.
6. Add/expand component, accessibility, and contract tests.
7. Run rendered desktop/mobile QA, critique, iterate, and save evidence.
8. Run full gates and publish the final architecture/QA/change record.
