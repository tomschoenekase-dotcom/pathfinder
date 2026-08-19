# Tochi Character System and System Super Architecture

Status: architecture implemented and repository-verified; final art remains pending
Date: 2026-08-19
Authoritative packet: `95 AI Staging/PathFinder System Super Implementation Packet 2026-08-19.md`

This note records the required repository audit and the architecture chosen before major System Super implementation. It is intentionally explicit about trust boundaries, fallback behavior, data ownership, and what is not being built. The goal is a durable character platform whose final art can be swapped without rewriting the client portal or public Venue Bot.

## Product boundaries

The following are separate product concepts and remain separate in code, UI language, permissions, prompts, storage, and analytics:

- **Torchiko** is the company and product brand. The company mark and core product hierarchy do not depend on a character.
- **Client Tochi** is an optional private helper for authenticated client users. It can see only a deliberately bounded client-visible projection and can offer a small allowlist of safe actions.
- **Venue Bot Classic** is the existing public visitor text-chat experience. It remains the default and a first-class presentation.
- **Venue Bot Character** is an optional presentation layer around that same public chat engine. Presentation must never expand knowledge or permissions.
- **Tochi as a Venue character** is the first code-registered character option. It is not the same runtime, prompt, or context as Client Tochi.
- **Character identity** is independent of personality. A venue can change tone without changing character, and selecting a character must not silently rewrite an existing tone preset.
- **Voice** is a future presentation/transport capability. Text Character Mode must not imply that voice is available today.

The non-negotiable trust split is:

```text
authenticated client portal
  -> client-assistant router
  -> client-visible projection only
  -> tiny safe action allowlist
  -> existing support domain after explicit confirmation

public visitor chat
  -> public chat router
  -> public venue projection only
  -> existing public knowledge/retrieval boundary
  -> no client-assistant, support, admin, agent, or MCP tools

internal operations
  -> existing admin/agent/MCP boundaries
  -> never reused as Client Tochi's execution environment
```

## Audit completed before implementation

### Existing portal and onboarding

The authenticated client surface uses the App Router, Clerk-backed tenant identity, tenant-scoped tRPC procedures, and the redesigned `DashboardShell`, `DashboardOverview`, and `RemoteOnboardingJourney`. The portal already has authoritative lifecycle, upload, question, preview, readiness, and support projections. The earlier Client Portal + Onboarding packet has been re-opened for quality review rather than treated as automatically complete.

Reusable foundations:

- `packages/api/src/routers/portal.ts` builds client-visible lifecycle and onboarding projections.
- `packages/contracts/src/client-portal-lifecycle.ts` and `remote-onboarding.ts` are the lifecycle source of truth.
- `apps/dashboard/components/DashboardShell.tsx` owns responsive navigation and focus behavior.
- `apps/dashboard/components/IntakeFileUpload.tsx` already has durable, resumable, verified upload transport.
- `support.createRequest` and its domain action provide the existing client/team request path.

Client Tochi must integrate beside this hierarchy. It cannot become a gatekeeper, replace the normal navigation, or hide any existing portal action.

### Existing public visitor chat

The public path is:

```text
apps/web/app/[venueSlug]/chat/page.tsx
  -> VenueChatExperience
  -> VenueChatShell
  -> ChatWindow
  -> public chat tRPC mutation
```

The current engine is synchronous, durable, and non-streaming. It reserves/finalizes turns, scopes every session and retrieval to the server-resolved tenant and venue, supports exact retry, fails open with a safe response, records model usage, and separates PUBLIC from authenticated SECOND_LAYER knowledge.

Important consequences:

- `isSending` can truthfully map to `thinking`.
- A terminal response can briefly map to `success`, then `idle`.
- Draft text can map to `listening` after the draft callback carries the value.
- `speaking` remains a supported semantic state but is not faked while the transport has no streaming or voice signal.
- Character Mode wraps the current chat. It does not replace its persistence, retrieval, retry, or authorization logic.

Two pre-existing public/mobile defects are part of this implementation:

- `VenueChatExperience` directly calls `crypto.randomUUID()` on a path where plain-HTTP mobile/webview environments may not provide it.
- The shared Torchiko brand requests `/torchiko-logo.svg`, but the public web app does not ship that asset.

### Existing personality system

The four presets in `packages/contracts/src/tone-presets.ts` are already versioned and backward compatible:

- `friendly`
- `concise`
- `enthusiastic`
- `informative`

Legacy values map as follows:

| Legacy value   | Versioned preset |
| -------------- | ---------------- |
| `FRIENDLY`     | `friendly`       |
| `PROFESSIONAL` | `informative`    |
| `PLAYFUL`      | `enthusiastic`   |

The existing resolver prefers a supported versioned preset, then legacy `aiTone`, then `friendly`. Venue updates already use tenant-scoped CAS/audit behavior. This system is preserved and becomes the preset axis of a broader Venue Bot configuration. Character selection never overwrites a migrated preset.

### Existing support and question systems

The support domain is already operation-ID/idempotency-hash based, membership checked, tenant and venue scoped, auditable, client/internal visibility aware, and attachment aware. `OnboardingQuestionLink` explicitly prevents creation of a third question system.

Client Tochi therefore uses:

1. a no-write handoff preview;
2. explicit client confirmation;
3. the canonical support creation action;
4. a narrow provenance record linking the confirmed assistant turn to the created request.

The human actor remains the authenticated client. Tochi never claims a human has read, started, or completed work unless authoritative state proves it.

### Auth, tenant isolation, and API boundaries

- Authenticated client procedures use `tenantProcedure`.
- Clerk membership supplies tenant identity.
- Prisma middleware requires tenant predicates for tenanted models.
- New tenant-owned models must be registered in `packages/db/src/tenanted-tables.ts` and relevant lifecycle/append-only guard lists.
- Public chat resolves tenant ownership from the requested venue on the server; caller-supplied tenant IDs are not authority.
- Character presentation is a sanitized public projection only. It cannot expose custom-character workflow metadata, storage references, client assistant threads, support content, feature-flag metadata, or internal asset diagnostics.

### Existing AI routing and observability

The repository already has a central Anthropic model registry, per-workload configuration, budgets, usage recording, model/token/cost/latency fields, and bounded Haiku patterns. Add a dedicated `CLIENT_TOCHI` workload rather than calling a provider from UI code or using the internal AgentRun system.

Client Tochi is not a general agent. It receives a small first-party context projection and an allowlist of action descriptors. It has no internet browsing, MCP, raw database, arbitrary URL, admin, or agent-run capability.

### Feature flags

Two existing mechanisms are reused:

- global environment kill switches in `@pathfinder/config`, default false;
- tenant-scoped `TenantFeatureFlag` allowlisting, default false.

Runtime enablement requires both layers. Venue configuration selects a presentation only after rollout authorization.

Planned keys:

| Logical capability     | Environment key                 | Tenant flag key            |
| ---------------------- | ------------------------------- | -------------------------- |
| Client Tochi           | `CLIENT_TOCHI_ENABLED`          | `client-tochi-v1`          |
| Venue Character Mode   | `VENUE_CHARACTER_MODE_ENABLED`  | `venue-character-mode-v1`  |
| Character registry     | `CHARACTER_REGISTRY_ENABLED`    | `character-registry-v1`    |
| Tochi public character | `TOCHI_VENUE_CHARACTER_ENABLED` | `tochi-venue-character-v1` |

### Assets and rendering inventory

No Tochi asset pack, character registry, semantic controller, Rive/Lottie/Three runtime, or voice infrastructure exists. React 19, Next.js, CSS modules, SVG, Tailwind, Lucide, `next/dynamic`, and existing reduced-motion patterns are sufficient.

The existing `TorchikoCore` is a brand-level final fallback. It is not the development Tochi pack because it cannot exercise layered eyes, embers, look-at, or all semantic states.

An external 20 MB FBX found outside the repository is not used: its provenance/license is unknown, it references a missing texture, and it is unsuitable for a lightweight browser placeholder.

### Voice inventory

No STT, TTS, voice profile, microphone, or low-latency audio transport exists. The public app intentionally disables microphone permission and the widget iframe does not grant it. That secure default remains. This implementation adds only explicit voice-profile and presentation seams; it does not pretend a voice product exists.

## Architecture decision

### Shared character contracts

Create `packages/contracts/src/character-system.ts` with versioned Zod contracts and pure resolution functions for:

- character definitions;
- asset manifests;
- presentation contexts;
- semantic states;
- renderer adapter keys;
- lifecycle/source/capability metadata;
- venue presentation configuration;
- custom personality bounds;
- fallback resolution;
- sanitized public character projections.

The fourteen required semantic states are:

```text
idle
attention
listening
thinking
speaking
success
processing
uploadReceiving
uploadComplete
question
handoff
error
sleeping
minimized
```

Supported initial renderer adapters:

- `layered-svg-v1`
- `static-image-v1`

Future Rive, Lottie, Canvas, or GLB renderers become new lazy adapters. Product components keep calling the same semantic API.

### Asset manifest

A manifest owns all asset paths. Components never scatter character URLs.

Required manifest concepts:

- schema version and immutable asset-pack ID/version;
- renderer adapter;
- art approval status and `publishable` flag;
- local asset references with media type, dimensions, bytes, and optional hash;
- canvas, safe bounds, origin, eye/look-at anchor, and ember anchor;
- thumbnail/selection preview;
- mandatory static fallback and reduced-motion fallback;
- optional layered body, eyes, embers, glow, and shadow;
- partial semantic-state mappings;
- explicit state fallbacks;
- supported themes/contexts;
- future voice metadata;
- attribution and internal handoff notes.

Validation rejects:

- missing static fallback;
- traversal or absolute/executable remote paths;
- fallback cycles;
- unknown states, contexts, renderer adapters, or media types;
- invalid bounds/dimensions/intensity values;
- duplicate registry IDs or mismatched definition/pack references;
- a supposedly production-publishable placeholder pack.

Fallback order is exact:

```text
requested state
  -> manifest-defined fallback state
  -> idle
  -> pack static fallback
  -> neutral Torchiko brand fallback
  -> no character, while core UI remains functional
```

### Canonical asset delivery

Canonical source:

```text
assets/characters/
  tochi/
    v0-development/
      manifest.json
      body.svg
      eyes.svg
      embers.svg
      preview.svg
      fallback.svg
```

A validating synchronization script copies allowlisted packs into both deployable Next apps and verifies hashes/paths:

```text
apps/dashboard/public/characters/
apps/web/public/characters/
```

This prevents cross-service filesystem assumptions and dashboard/web drift. Tenant-provided SVG will never be inlined into application DOM; future custom assets are rendered as sanitized, reviewed resources.

### Placeholder pack

The stable character definition ID is `tochi`. Its initial pack is `tochi-dev-v0`, with:

```text
artStatus: placeholder
publishable: false
version: 0-development
```

It is deliberately simple: an abstract flame, two eyes, and an ember layer. It exists only to exercise the contract and state machine. The Character Lab visibly labels it “Temporary development assets.” Production selection requires an approved/publishable pack in addition to all rollout flags, so provisional art cannot accidentally ship as final character work.

### Shared renderer and controller

Reusable UI lives under `packages/ui/src/character/`:

```text
CharacterPresence.tsx
CharacterRenderer.tsx
LayeredSvgRenderer.tsx
StaticCharacterFallback.tsx
character-controller.ts
character.css
```

Product surfaces pass semantic intent, not animation mechanics:

```ts
type CharacterPresenceProps = {
  definition: CharacterDefinition
  manifest: CharacterAssetManifest
  state: CharacterState
  context: CharacterPresentationContext
  motion: 'system' | 'reduced' | 'full'
  intensity?: number
  lookAt?: { x: number; y: number }
  size?: 'compact' | 'standard' | 'stage'
  onAssetError?: (error: CharacterAssetError) => void
}
```

The controller is a pure reducer plus a React hook. It supports semantic `setState`, event `react`, `lookAt`, `setIntensity`, `pause`, and `reset` operations. It clamps input, pauses in hidden tabs, honors reduced motion, and uses transition tokens so an old delayed reset cannot overwrite newer state.

The visual is decorative during status transitions. All meaningful state has text and/or live-region equivalents. Selection previews use an accessible name.

No new animation or 3D dependency is justified for the provisional system.

### Client Tochi domain

Client Tochi gets its own authenticated domain. It does not use `VisitorSession`, `GuestChatTurn`, `AgentRun`, `AgentMessage`, or MCP.

Proposed models:

- `ClientAssistantPreference`: tenant/user unique enabled/minimized preference.
- `ClientAssistantThread`: tenant/user and selected venue scope, bounded status and timestamps.
- `ClientAssistantTurn`: append-oriented user/assistant/system result turns with bounded content and structured safe-action metadata.
- `ClientAssistantSupportHandoff`: exact tenant/venue/turn/request provenance, confirmation, operation ID/hash.

All carry explicit tenant scope; venue-bearing records use composite tenant/venue relationships. Cross-tenant access fails before reads or writes.

The router exposes a small surface:

- `bootstrap`: feature availability, preference, authorized venues, current safe status/help context;
- `setPreference`: bounded optimistic preference update;
- `openThread` or lazy thread creation;
- `send`: bounded history plus current context, deterministic answers where possible, cheap model fallback, sanitized result;
- `previewHandoff`: structured no-write summary;
- `confirmHandoff`: idempotently creates the canonical support request after explicit confirmation.

Allowlisted client actions are descriptors, not arbitrary tools:

- navigate to a portal route/anchor from a server allowlist;
- open an existing setting;
- explain a current configuration or lifecycle state;
- preview a support/change request;
- confirm a previously previewed support request;
- surface an already-authoritative pending question.

No publication, approval, deployment, credential, raw storage, cross-tenant, agent-run, or admin action is available.

If Client Tochi is disabled or fails, the portal remains fully usable and links directly to normal Help & changes.

### Client Tochi behavior layer

The behavior specification is versioned and inspectable in `packages/ai`, not embedded in a React component. It separates:

- locked role/scope/safety/truthfulness rules;
- client-visible context projection;
- current venue/task facts;
- bounded conversational history;
- allowlisted action descriptions;
- response schema.

It answers first, stays concise, distinguishes advice from confirmed system state, never exposes internal debugging or another tenant, never claims a human has acted without evidence, and never pressures a client toward Character Mode.

The initial `CLIENT_TOCHI` model is the existing bounded Haiku family with lower context/output limits than general guest chat where practical. It does not browse the internet. Deterministic first-party answers handle common navigation/upload/presentation questions without a provider call when possible.

### Liaison and support handoff

Handoff sequence:

```text
conversation intent
  -> classify as advice / safe navigation / support-worthy change
  -> preview structured summary to client
  -> explicit confirmation
  -> canonical support.createRequest domain action
  -> durable provenance link
  -> truthful confirmation that it was sent for review
```

The preview may include venue, category, summary, requested outcome, relevant feature/entity, explicitly supplied urgency, safe excerpt/context, and selected existing attachments. No raw model chain-of-thought or internal prompt is stored.

### Venue Bot configuration

The current tone-only boxes evolve into one coherent configuration with independent axes:

1. **Presentation**: Classic (default) or Character.
2. **Personality**: the four existing presets or a bounded custom personality.
3. **Character**: Tochi or a future registered/authorized character, only when Character is selected.
4. **Name**: optional public display name.
5. **Greeting**: optional bounded greeting.
6. **Voice profile**: nullable future reference, not an enabled voice feature.

Classic is the default in schema, resolver, migration, and public projection. Flag-off, missing/disabled character, invalid pack, or unapproved pack resolves safely to Classic or static fallback without altering the saved tone.

The existing `Venue.aiTone`, `tonePreset`, and `tonePresetVersion` remain during compatibility migration. Updates dual-write preset compatibility fields while older deployment/package consumers exist.

### Persistence choice

Use additive, forward-safe tables rather than packing unrelated state into `Venue` JSON or duplicating the existing tone columns:

- `VenueBotConfiguration`, unique by tenant/venue, stores presentation, personality mode, existing preset reference, custom personality reference, character key/custom character reference, public name/greeting, future voice profile, revision, and actor/timestamps.
- `PersonalityProfile`, tenant scoped and optionally venue owned, stores bounded client-editable style parameters and custom instruction. Locked safety/system rules remain code-owned.
- `CustomCharacter`, tenant/venue scoped, stores request lifecycle (`REQUESTED`, `GENERATING`, `REVIEW`, `ACTIVE`, `ARCHIVED`), reviewed asset/preview references, capability metadata, and version.
- Client assistant models described above.

System/template character definitions remain code/manifest registered. Only tenant custom character records persist.

Migration rules:

- additive tables/enums/nullable references only;
- Classic defaults for all existing venues;
- backfill the effective existing preset without deleting or renaming legacy fields;
- compound tenant/venue foreign keys and indexes throughout;
- optimistic revisions for mutable configuration;
- append-oriented assistant turns and handoff provenance;
- no destructive cleanup in this packet.

Venue Bot fields must be deliberately threaded through any full/native deployment, preview, diff, apply, rollback, and content-history contracts that promise exact configuration. The UI cannot claim a preview is exact if the character pack version is not pinned.

### Public Character Mode

The public venue projection returns only:

- resolved presentation mode;
- public character ID/display name;
- pinned approved asset-pack ID/version;
- sanitized renderer/public asset references;
- greeting and compatible public personality label where needed.

It never returns tenant IDs, private assistant state, support context, custom workflow status, storage internals, feature-flag metadata, or arbitrary prompt text.

The character UI is lazy loaded only when the resolved public presentation is Character. Classic users must not download the optional character module/assets. The current `ChatWindow` remains text dominant.

Mobile composition:

- expanded but bounded character stage only in the empty/start state;
- compact presence during an active conversation;
- character stage target below roughly one quarter of the phone viewport during active chat;
- composer/messages retain priority, safe areas, 44 px targets, and 16 px input text;
- failed character code or assets leave messages and composer intact.

Truthful initial state mapping:

| Chat event                     | Character state          |
| ------------------------------ | ------------------------ |
| Open/empty                     | `attention`, then `idle` |
| Non-empty draft                | `listening`              |
| Submit/await terminal response | `thinking`               |
| Terminal assistant response    | `success`, then `idle`   |
| Recoverable failure            | `error`, then `idle`     |
| Inactive                       | `idle`                   |
| Minimized                      | `minimized`              |
| Streaming delta (future only)  | `speaking`               |

### Voice seam

The contracts reserve:

- `venue-voice-chat` presentation context;
- optional `voiceProfileId` and manifest voice metadata;
- `listening`, `speaking`, `attention`, `sleeping`, and interruption-capable controller states;
- a future adapter boundary for audio level/viseme-like intensity without requiring a mouth.

No microphone permission, iframe capability, or audio transport changes occur until a separately reviewed voice implementation provides consent, captions/transcript, interruption semantics, and security review.

### Future template and custom characters

Adding a Torchiko template character requires only:

1. validated character definition;
2. validated asset pack;
3. semantic-state mappings/fallbacks;
4. selection preview;
5. default personality reference;
6. optional future voice profile.

Core chat code does not change.

Custom characters use server-resolved tenant/venue ownership and reviewed assets. Public clients never select an arbitrary manifest URL or inline custom SVG. The initial packet creates the lifecycle/data seams, not an asset-generation studio.

### Character Lab and fixtures

Create a platform-admin-only, server-flagged `/admin/character-lab` route. It reads only trusted local registry packs and performs no client-data mutation or arbitrary URL loading.

It provides:

- character and pack selection;
- all fourteen semantic states;
- light/dark/branded/transparent backgrounds;
- compact client-helper, compact text-chat, expanded start, future voice-stage, and marketing contexts;
- viewport presets;
- system/reduced/static motion controls;
- look-at and intensity controls;
- pause/replay;
- simulated asset failure;
- fallback-chain and manifest diagnostics;
- renderer/version/loaded-byte details;
- deterministic query parameters and a state matrix.

Development fixtures cover portal/onboarding states from the first packet plus client handoff/minimized/disabled, Classic, Character, selection, mobile long text chat, thinking, simulated speaking, error, asset failure, and reduced motion.

### Analytics and cost

Add the packet events to the trusted server-only analytics catalog, not the public browser event allowlist:

- `client_tochi_opened`
- `client_tochi_message_sent`
- `client_tochi_handoff_created`
- `client_tochi_disabled`
- `venue_bot_presentation_changed`
- `character_selected`
- `custom_personality_saved`
- `character_chat_started`
- `character_mode_disabled`

Metadata contains IDs, enum categories, model, latency, result, and action names—not raw private conversation text. Existing AI usage records capture provider/model/tokens/cost/latency/success. A bounded correlation reference links usage to an assistant turn without pretending it is a visitor session. Internal costs never appear in client UI.

### Accessibility

- Every dialog/sheet moves focus inside, traps Tab/Shift+Tab, closes on Escape, and restores focus to its opener.
- The assistant visual is decorative when text conveys the state.
- Meaningful controls have accessible names and 44 px targets.
- Status, send, failure, and handoff outcomes use textual/live-region equivalents.
- State is never color only.
- `prefers-reduced-motion: reduce` resolves to static or minimal opacity-only presentation; explicit reduced/static lab modes allow deterministic testing.
- Users can disable Client Tochi and minimize/pause appropriate character surfaces.
- Contrast is verified in a real browser because jsdom axe cannot compute it reliably.

The dialog behavior follows the W3C ARIA Authoring Practices dialog pattern: contained focus, Escape close, labelled dialog semantics, and focus restoration. Reduced-motion handling follows the platform media preference rather than a user-agent guess.

Primary references:

- W3C APG dialog pattern: <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- MDN `prefers-reduced-motion`: <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion>
- Next.js lazy loading guide: <https://nextjs.org/docs/app/guides/lazy-loading>
- Prisma compound IDs/constraints: <https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-composite-ids-and-constraints>

### Performance

- No Rive, Lottie, Motion, Three, Canvas framework, or new runtime library for the placeholder system.
- Character code and assets load only for authorized Character presentation.
- Static/reduced fallbacks are small and immediately available.
- Animation uses CSS transform/opacity and simple SVG layers.
- Timers and pointer listeners are cleaned up; hidden tabs pause non-essential activity.
- Manifest files declare byte sizes, and verification enforces initial budgets.
- Classic build/network evidence must prove that the optional character chunk/assets are not requested.
- Final richer formats require a measured adapter-specific budget and static fallback before adoption.

### Failure behavior

| Failure                           | Required result                                         |
| --------------------------------- | ------------------------------------------------------- |
| Character pack invalid            | Registry rejects it; Classic remains available          |
| Optional character chunk fails    | Static/brand fallback; chat remains usable              |
| One layer fails                   | Static pack fallback; chat remains usable               |
| Animation/controller fails        | Static presence or no character; text state remains     |
| Client Tochi model fails          | Portal remains usable; normal Help & changes is offered |
| Public chat model fails           | Existing safe chat fallback remains                     |
| Handoff confirmation is ambiguous | Idempotent operation replay resolves exact result       |
| Feature flag disabled             | No private assistant/character runtime exposed          |
| Unknown/disabled character ID     | Safe Classic or approved static fallback                |

## Implementation sequence

1. Repair pre-existing public mobile/brand defects.
2. Add and test character contracts, registry, manifest validation, controller, renderer, placeholder pack, synchronization, and fallback behavior.
3. Add global/tenant rollout checks and analytics catalog entries.
4. Add additive data model/migration and tenant-isolation registrations.
5. Evolve Venue Bot configuration while preserving all four preset mappings and Classic default.
6. Add safe public projection and lazy Character presentation around existing chat.
7. Add Client Tochi prompt behavior, tenant router/domain, preference, conversation UI, and confirmed support handoff.
8. Add protected Character Lab and deterministic fixtures.
9. Run contract/component/API/migration/tenant/accessibility/build gates.
10. Run real-browser desktop/tablet/mobile, reduced-motion, asset/AI failure, long-chat, console, overflow, contrast, and lazy-load QA; iterate from what is observed.
11. Complete `TOCHI-ASSET-HANDOFF.md`, `TOCHI-PROMPT-BEHAVIOR.md`, and `TOCHI-QA.md` with exact commands and evidence.

## Acceptance gates

Automated gates include:

- manifest/definition/registry validation and duplicate rejection;
- exact semantic fallback resolution and fallback-cycle rejection;
- reduced-motion resolution;
- controller stale-reset protection and cleanup;
- Classic default and unchanged DOM/behavior contracts;
- all four presets preserved through configuration updates;
- presentation/character/personality persistence with CAS/audit;
- deployment/preview/apply/rollback exactness where relevant;
- public projection sanitization;
- Character lazy-load and failed-asset resilience;
- Client Tochi enabled/disabled/open/send/fallback;
- deterministic and model-backed response paths;
- context isolation and unauthorized-action denial;
- handoff preview/confirmation/idempotency/truthful copy;
- cross-tenant denial for every new tenant-owned model/procedure;
- public visitor inability to invoke or read client assistant/support/admin tools;
- analytics events contain no raw conversation content;
- browser accessibility, responsive, console, and asset checks.

Human/device-only late checks are limited to native iOS/Android picker and touch behavior inherited from onboarding, OS-level reduced-motion preference on a physical device, and final subjective brand judgment. They are documented rather than falsely claimed.

## Explicit non-goals for this packet

- Final Tochi art or a permanent silhouette decision.
- A character-generation studio.
- Full voice chat, microphone enablement, STT, or TTS.
- Replacing Classic chat.
- Streaming merely to animate a speaking state.
- A general autonomous client agent.
- Internet browsing from Client Tochi.
- Direct MCP or internal agent-run access.
- A marketing-site redesign.
- Hardcoded pricing for custom characters.

This architecture keeps the serious SaaS product complete without Tochi, makes Tochi useful where he reduces client effort, and lets final design assets replace the development pack through a versioned manifest rather than a product rewrite.

## Implementation closeout

The implementation sequence above has landed. The durable contracts, provisional non-publishable asset pack, shared renderer/controller, Character Lab, global-plus-tenant rollout controls, additive persistence, public Character adapter, bounded custom personality, Client Tochi conversation domain, explicit support confirmation, analytics, deployment preservation, deterministic fixtures, and failure boundaries are all present in the repository.

The final verification record—including exact test totals, browser viewports and states, screenshot paths, migration-chain evidence, lazy-chunk proof, and the remaining human-only checks—is maintained in `docs/TOCHI-QA.md`.
