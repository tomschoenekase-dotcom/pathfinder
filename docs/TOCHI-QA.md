# Tochi and System Super QA Record

Status: implemented and repository-verified; final art and physical-device checks remain explicitly external
Date: 2026-08-19
Scope: `PathFinder System Super Implementation Packet 2026-08-19.md` plus regression of the Torchiko Client Portal + Onboarding overhaul

## Outcome

The optional Client Tochi and Venue Bot Character foundations are integrated without replacing or weakening Classic Venue Bot, the client portal, onboarding, tenant isolation, support, retry, or publication boundaries.

- Classic remains the default and works without a character pack.
- Client Tochi is an authenticated, tenant-scoped helper with a bounded client-visible projection and a tiny server-owned action allowlist.
- A support handoff is previewed first and written only after explicit confirmation through the existing support domain.
- Venue Bot presentation, character selection, and personality are independent, versioned configuration axes.
- The four existing presets remain supported. Custom personality is bounded and cannot override platform truth, safety, privacy, or authorization rules.
- The provisional Tochi pack is intentionally marked `0-development`, non-publishable, and replaceable through the versioned manifest contract.
- Voice types and capability boundaries exist, but microphone, STT, TTS, and voice chat are not claimed or enabled.

## Important implementation surfaces

### Contracts and assets

- `packages/contracts/src/character-system.ts`
- `packages/contracts/src/venue-bot-configuration.ts`
- `packages/ui/src/character/`
- `assets/characters/tochi/v0-development/`
- `scripts/verify-character-assets.mjs`
- `scripts/sync-character-assets.mjs`
- `apps/dashboard/components/admin/CharacterLab.tsx`

### Client Tochi

- `packages/ai/src/client-tochi-behavior.ts`
- `packages/api/src/routers/client-assistant.ts`
- `packages/api/src/lib/client-assistant-security.ts`
- `packages/db/src/helpers/client-assistant-actions.ts`
- `apps/dashboard/components/ClientTochiWorkspace.tsx`
- `apps/dashboard/components/ClientTochiPanel.tsx`
- `apps/dashboard/components/ClientTochiPreference.tsx`

### Venue Bot configuration and public presentation

- `apps/dashboard/components/AiControlsForm.tsx`
- `apps/dashboard/components/CustomPersonalityEditor.tsx`
- `packages/api/src/lib/character-registry.ts`
- `packages/api/src/routers/venue.ts`
- `apps/web/components/VenueCharacterStage.tsx`
- `apps/web/components/VenueCharacterBoundary.tsx`
- `apps/web/components/VenueChatShell.tsx`

### Rollout, persistence, and deployment

- `packages/config/src/feature-flags.ts`
- `packages/api/src/routers/admin/tochi-rollout.ts`
- `apps/dashboard/components/admin/AdminTochiRolloutForm.tsx`
- `packages/db/prisma/migrations/20260819120000_add_tochi_persistence_foundation/`
- `packages/db/prisma/migrations/20260819130000_add_normalized_personality_dimensions/`
- `packages/contracts/src/native-venue-deployment.ts`
- `packages/api/src/lib/full-venue-deployment-manifest.ts`

## Automated verification

Fresh gates on the final worktree:

| Gate                                             | Result                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `pnpm --filter @pathfinder/contracts test`       | 139 passed                                                                               |
| `pnpm --filter @pathfinder/ui test`              | 17 passed                                                                                |
| `pnpm --filter @pathfinder/config test`          | 62 passed                                                                                |
| `pnpm --filter @pathfinder/analytics test`       | 4 passed                                                                                 |
| `pnpm --filter @pathfinder/ai test`              | 67 passed                                                                                |
| `pnpm --filter @pathfinder/db test`              | 1,037 passed; 81 explicitly guarded integration cases skipped                            |
| `pnpm --filter @pathfinder/api test`             | 1,096 passed; 57 explicitly guarded integration cases skipped                            |
| `pnpm --filter @pathfinder/dashboard test`       | 708 passed                                                                               |
| `pnpm --filter @pathfinder/web test`             | 289 passed                                                                               |
| `pnpm --filter @pathfinder/workers test`         | 366 passed; 1 environment integration skipped                                            |
| `pnpm --filter @pathfinder/jobs test`            | 61 passed; 8 Redis integration cases skipped                                             |
| `pnpm --filter @pathfinder/intake-engine test`   | 15 passed                                                                                |
| `pnpm --filter @pathfinder/auth test`            | 27 passed                                                                                |
| `pnpm test:accessibility`                        | dashboard 5 + web 2 passed                                                               |
| `pnpm test:browser-foundation`                   | dashboard 125 + web 61 passed                                                            |
| `pnpm test:scripts`                              | 153 passed; 1 intentional legacy-data fixture skipped                                    |
| `pnpm typecheck`                                 | 23/23 tasks passed across 13 workspaces                                                  |
| `pnpm lint`                                      | 13/13 workspaces passed; zero errors, one pre-existing guest image optimization advisory |
| `pnpm build`                                     | 13/13 workspaces passed, including both optimized Next builds and worker bundle          |
| `pnpm characters:sync && pnpm characters:verify` | 12 files synchronized; `tochi-dev-v0@0-development` verified                             |

The generated cross-tenant API suite includes every Client Tochi tenant procedure and passed 98 cases. The final inventory added the multipart sign/complete/cancel procedures and onboarding correction creation that the explicit coverage verifier found outside the previous case catalog. The Prisma tenant registry, procedure inventory, feature flags, support confirmation idempotency, public projection sanitization, model cost correlation, deployment round trips, and failure fallbacks have dedicated tests.

Security inventory gates were also run independently of the package test suites:

- 112 Prisma models classified: 102 tenanted, 8 platform, and 2 shared-scope;
- 184 tenant-isolation bypass calls pinned across 63 reviewed production files;
- 89 exact raw SQL operations approved by narrow policy after consolidating a duplicate Client Tochi generation lock;
- 6 public tRPC procedures, 7 HTTP route modules, and 2 dashboard public API paths reconciled;
- the operational agent bridge is now an explicit machine-credential ingress admitted through middleware, while its route retains bounded bearer validation and rejects prefix-adjacent public paths;
- 15 AI gateway call sites carry budget context and the provider boundary covers 1,453 source files;
- forced production builds under 11 secret canaries scanned 406 browser-deliverable files across both Next applications without a server credential match.

## Database migration evidence

The complete chain of 110 migrations was applied successfully to a fresh disposable `pgvector/pgvector:pg16` PostgreSQL container using explicit loopback URLs for both `DATABASE_URL` and `DIRECT_DATABASE_URL`. Verification confirmed:

- all 110 migration records applied;
- normalized personality dimensions default to 50;
- all three personality bound constraints exist;
- the guarded 15-step remote-onboarding lifecycle passed from sanitized invitation through exact rollback on a separate fresh loopback-only database;
- the temporary container was removed after verification.

The final managed local-staging database was also inspected read-only after restart: all seven new
configuration/assistant tables are present; all 20 existing venue-bot rows resolve to
`CLASSIC` + `PRESET`; there are no enabled/disabled tenant rows for the four new rollout keys, so
the default-false resolver remains authoritative; and there are zero Client Tochi turns or provider
claim identifiers in the disposable environment. The provider-disabled worker reported an empty
queue set.

The operational phone-upload bridge was corrected after the final packet audit found that signed
object URLs still used `127.0.0.1`, which is unreachable from a phone. Managed startup now resolves
the PC's active LAN address for the MinIO API and CORS origin while leaving the database, queue,
scanner, and storage console loopback-only. LAN health and exact upload preflight passed, followed
by nine live storage/scanner cases covering PDF, the supported image formats including PNG,
multipart video, checksums, byte verification, readback, and cleanup.

Operational transparency: the first migration-status attempt overrode only `DATABASE_URL`. Prisma uses `DIRECT_DATABASE_URL` for migration commands, so eight outstanding forward-only/additive migrations were applied to the configured Supabase database before the mistake was detected. The operation succeeded, contained no destructive/drop statements, and the configured database subsequently reported `Database schema is up to date!` with 110 migrations. This event is retained here rather than being hidden.

## Real-browser matrix

The deterministic fixtures and authenticated routes were inspected in the in-app Chromium browser at:

- 390 × 844 mobile;
- 768 × 1024 tablet;
- 1440 × 1000 desktop.

States exercised:

- onboarding Welcome, Share, Processing, Questions, Ready;
- upload selected, uploading, recoverable error, joined/saved;
- client portal Live and Paused;
- Client Tochi open, long conversation, handoff preview, minimized, disabled, and failure-safe states;
- Venue Bot settings Classic, custom personality, and unavailable Character intent;
- admin rollout controls;
- public Classic chat;
- public Character idle/listening/thinking/speaking-simulation/error;
- missing Character asset fallback;
- explicit reduced-motion fixture.

Across the 390/768/1440 matrix there was no horizontal overflow, duplicate ID, broken image, or unlabeled interactive control. Current contrast checks found zero failing text selectors after corrections. Measured minima from the portal/onboarding pass were 4.57:1 or higher; public chat uses a separately derived `accentText` token that is guaranteed to meet 4.5:1 on both chat surfaces.

Authenticated smoke routes included:

- `/ai-controls` with the real TestOne venues and saved Venue Bot configuration;
- `/venues/cmo286it60003k901ojq22czy/onboarding`;
- `/admin/clients/org_3I6y6sNh4LrveTj9Q1DmekI5K4g` with rollout controls.

The clean post-restart sweep recorded zero browser console errors. Clerk development-key warnings are expected in local development and are not runtime failures.

After the final Character Lab controls landed, a separate 390 × 844 live pass switched from
`size=compact`/`venue-text-chat` to `size=stage`/`venue-voice-chat`. Both compositions retained zero
horizontal overflow and zero broken images. The simulated missing pack settled on the real
`/torchiko-logo.svg` brand fallback with no broken image left mounted. The public `/offline.html`
fallback also rendered **Torchiko Offline**, a 44 px Reload action, exact-width mobile layout, and
zero browser errors. The viewport override was reset and the QA tabs were closed afterward.

A final restarted-local-staging touch-target audit found sub-44 px controls in the public chat
header, prompts, and footer plus the upload queue category selector. Those hit areas were raised to
at least 44 × 44 CSS pixels and pinned by component/CSS contracts. The 390 × 844 browser recheck of
upload Error plus Classic and Character long-chat states then reported zero undersized interactive
targets, overflow, broken images, or browser errors.

The same all-state Client Tochi mobile pass found its inline **Open Information** action had only a
text-height target. It now has a 44 px minimum target with a CSS regression contract; Empty,
History, Handoff, Failure, Minimized, and Disabled fixtures rechecked without overflow or broken
images, and History has no remaining undersized control. Character lazy loading also uses truthful
“getting ready” copy, while the “unavailable” message is reserved for an actual renderer error.

The authenticated `/admin/new` path was then inspected against the managed local-staging database.
It exposes the intended primary-contact → client → first-venue workflow and states that creation is
private and invitation-driven. Its mobile navigation trigger and **← Clients** action were raised
from 36/text-height to 44 px targets, contract-tested, and remeasured at 390 × 844 with no remaining
undersized control, overflow, or broken image. A final plain-HTTP audit also moved this form's
idempotency request ID onto the tested `getRandomValues` UUID fallback, so the first step of the
phone workflow no longer depends on secure-context-only `crypto.randomUUID()`.

A current local-staging client was then selected through the real Admin preview control and its
saved `/venues/:venueId/onboarding` journey loaded against authoritative data. The Processing state,
saved floor plan, shared website, material counts, admin-view bridge, and disclosure content all
rendered at 390 × 844. The audit found and corrected a text-height source website link and the 36 px
admin-view return control. The authenticated route then rechecked with one `main`, one `h1`, no
undersized control, overflow, duplicate ID, or broken image. The preview cookie was returned to
Admin after the audit.

Current screenshots:

- `docs/evidence/system-super-client-tochi-mobile.png`
- `docs/evidence/system-super-client-tochi-handoff-desktop.png`
- `docs/evidence/system-super-venue-bot-custom-mobile.png`
- `docs/evidence/system-super-venue-bot-custom-desktop.png`
- `docs/evidence/system-super-rollout-mobile.png`
- `docs/evidence/system-super-rollout-desktop.png`
- `docs/evidence/system-super-classic-chat-mobile.png`
- `docs/evidence/system-super-character-chat-mobile.png`
- `docs/evidence/system-super-character-chat-desktop.png`
- `docs/evidence/system-super-character-fallback-mobile.png`

## Accessibility and motion

- Client Tochi uses labelled dialog semantics, focus containment, Escape close, focus restoration, textual status, and 44 px controls.
- The portal mobile drawer is modal to assistive technology while open and prevents background navigation.
- The onboarding journey now has one main landmark and unique named regions; the materials anchor is not a duplicate landmark.
- Character state always has a text equivalent; presentation is not communicated by color alone.
- The explicit reduced-motion Character fixture computed `animation: none` and zero-duration transitions.
- Source and component contracts also cover system `prefers-reduced-motion`, timer/listener cleanup, and static fallback.

## Performance and lazy loading

No Rive, Lottie, Framer Motion, Three.js, WebGL, or new animation runtime was added.

The public chat uses an async `VenueCharacterStage` import. Production build inspection showed:

- Classic chat initial route chunks do not include the current 7.0 KB combined Character stage/renderer chunk;
- the route contains only the small webpack async-loader reference until a sanitized Character projection is present;
- the character pack itself is requested only by Character presentation;
- failed chunk/asset rendering is contained by a static Torchiko fallback while text chat remains usable.

Shared UI exports are split into `@pathfinder/ui/theme`, `/brand`, `/fade-in`, and `/character` so importing chat theme or brand primitives cannot pull the character barrel into Classic or marketing entry points.
`scripts/character-bundle-boundary.test.mjs` makes that split durable by rejecting a character export from the root UI barrel, any static Character renderer import outside the lazy stage, or removal of the async stage boundary.

## Feature rollout and failure boundaries

All new global environment switches default false. Runtime Character or Client Tochi exposure requires the global kill switch and the tenant allowlist; public Character presentation additionally requires reviewed configuration and an approved publishable registry entry. The only bundled Tochi art is non-publishable, so current saved Character intent safely resolves to Classic in production.

Verified failure behavior:

- unknown/disabled/non-publishable character → Classic or static fallback;
- missing asset → Torchiko fallback with text chat intact;
- Client Tochi provider failure → portal and ordinary Help & changes remain available;
- ambiguous/replayed handoff → exact idempotent support result;
- unauthorized or cross-tenant request → nondisclosing denial before provider or support writes;
- no streaming signal → no fabricated `speaking` state in production chat;
- microphone remains denied by default and the widget does not request microphone permission.

## System Super final report

1. **Architecture chosen:** a code-backed, versioned Character registry and manifest in shared contracts; a renderer/controller in shared UI; separate tenant-scoped Client Tochi data and API; and an optional, lazily loaded public Venue Bot presentation layer around the existing durable chat engine.
2. **What existed before:** synchronous Classic visitor chat, four versioned tone presets, tenant-scoped portal/onboarding/support domains, AI model/cost routing, and strong tenant middleware. There was no Character contract, Client Tochi domain, voice seam, or character configuration.
3. **What changed:** added the generic Character platform, Client Tochi, explicit support handoff provenance, Venue Bot presentation/personality configuration, rollout controls, deterministic fixtures, public Character rendering, analytics, and full QA/security coverage while preserving Classic.
4. **How Client Tochi works:** the authenticated portal opens a tenant-scoped helper over a bounded client-visible projection. It uses a dedicated cheap workload, durable claim/replay semantics, a server-owned safe action allowlist, user preference/minimize state, and fail-open portal boundaries.
5. **How liaison/handoff works:** Tochi prepares a structured preview; only explicit client confirmation calls the existing idempotent support action. The handoff stores exact tenant, venue, turn, request, operation, excerpt, and confirmation provenance without claiming that a person has read or completed it.
6. **Classic versus Character Venue Bot:** Classic remains the default and keeps the existing chat transport, knowledge, retry, and accessibility behavior. Character is a sanitized presentation projection behind global, tenant, configuration, and publishable-registry gates; it loads lazily and falls back without taking down text chat.
7. **Personality configuration:** the four existing presets remain versioned and backward-compatible. Presentation mode, preset/custom personality, and character selection are independent axes; bounded custom dimensions cannot replace locked platform safety or truth rules.
8. **Character framework:** semantic context/state contracts, manifest validation, deterministic state fallback, motion policy, reusable renderer adapters, error boundaries, public projection sanitization, registry validation, and Character Lab fixtures are shared rather than Tochi-specific.
9. **Placeholder assets:** `tochi-dev-v0@0-development` is a layered SVG development pack with explicit provisional and non-publishable metadata. It exercises the full renderer/state pipeline but cannot be selected for public production.
10. **Final assets still needed:** approved Tochi layered/static assets for required semantic states, final palette/background variants, eye/look behavior, motion timing, accessible static and reduced-motion fallbacks, preview/contact sheet, and the signed-off manifest metadata listed in `docs/TOCHI-ASSET-HANDOFF.md`.
11. **Replacement process:** add the versioned pack under `assets/characters/tochi/`, complete its manifest, run sync and verification, inspect every state/context in Character Lab, approve the registry entry, then enable rollout gates. Application components do not need redesign.
12. **Dependencies added:** System Super added no animation, 3D, dropzone, or voice runtime. Across
    both packets, `hash-wasm` is the one focused runtime addition and exists solely for incremental
    SHA-256 over large resumable uploads; presentation uses existing React, Next, CSS/SVG, Lucide,
    Zod, Prisma, tRPC, and repository tooling.
13. **Database migrations:** `20260819120000_add_tochi_persistence_foundation` adds additive tenant-scoped configuration, profile, custom-character, preference, thread/turn, handoff, and provider-claim structures; `20260819130000_add_normalized_personality_dimensions` adds bounded normalized personality values. The full 110-migration chain passed on a fresh disposable database.
14. **Feature flags:** `CLIENT_TOCHI_ENABLED`, `VENUE_CHARACTER_MODE_ENABLED`, `CHARACTER_REGISTRY_ENABLED`, and `TOCHI_VENUE_CHARACTER_ENABLED` default false. Exposure requires the relevant global switch plus tenant allowlist; public Character also requires approved configuration and a publishable pack.
15. **Tests:** the exact current automated results and security inventories are recorded above, including the 708 dashboard and 289 web tests, root suite, type/lint/build, accessibility/browser foundations, asset checks, and guarded 15-step onboarding lifecycle.
16. **Browser/device QA:** deterministic and authenticated browser passes covered 390 × 844, 768 × 1024, and 1440 × 1000 across portal, onboarding, Client Tochi, configuration, Classic/Character chat, loading, error, fallback, and reduced-motion states. Physical native-picker/touch checks remain listed below.
17. **Security and tenant isolation:** every tenant procedure is generated-cross-tenant tested; new models are registered; public projections exclude private workflow/storage/provider state; support confirmation is idempotent; Client Tochi never receives MCP, AgentRun, browser, or admin capabilities; machine ingress is explicitly credential-bounded.
18. **Known limitations:** the current Tochi art is deliberately provisional/non-publishable; production chat is non-streaming, so the app does not fabricate speaking; voice is schema/capability scaffolding only; provider-disabled local staging cannot demonstrate a live paid model response; physical iOS/Android picker feel remains manual.
19. **Recommended next step:** deliver the approved Tochi asset pack, follow the asset-handoff checklist through Character Lab, publish the reviewed registry version to a founder-only tenant, and run the documented mobile smoke matrix before widening rollout.

## External/human-only completion items

These are not software omissions and are not falsely claimed as complete:

1. Replace the provisional non-publishable Tochi pack with approved final art and complete the Character Lab approval checklist.
2. Verify touch feel and the native file picker/camera source on physical iOS and Android devices.
3. Verify the OS-level reduced-motion preference on a physical device browser.
4. Obtain founder/designer subjective approval of final Tochi art and brand fit.
5. Enable voice only in a later, separately reviewed transport/security implementation; current voice fields are capability scaffolding only.

Until final art is approved, Classic remains the safe public experience and Client Tochi uses the replaceable development presence only in explicitly enabled private environments.
