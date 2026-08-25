# PathFinder launch capability handoff

Date: 2026-08-19

## Completed

- **New — product entitlements:** closed capability registry, plan mappings, append-only tenant/venue overrides, trials, emergency feature gating, admin procedures, and widget/voice enforcement.
- **Improved — AI gateway and cost evidence:** capability-based routing, ordered provider/model fallbacks, runtime platform/tenant/venue configuration, route metadata, multimodal usage, idempotent provider request IDs, and daily audio rollups.
- **New — realtime voice foundation and visitor UI:** provider-neutral adapter, OpenAI ephemeral browser authorization, public-session ownership, public-only knowledge context, quotas, atomic concurrency admission, transcript text, WebRTC controls, interruption, reconnect, text fallback, multilingual metadata, accessibility, and character-state hooks.
- **Hardened 2026-08-25 — abandoned voice recovery:** a recurring provider-dark worker atomically expires orphaned authorization, ready, and active sessions using their technical/provider/persisted-duration boundaries, releases concurrency, preserves fresh and terminal rows, and records replay-safe operational evidence. A fresh disposable PostgreSQL shakedown proves the lifecycle and cleanup contract.
- **New — browser Voice Mode boundary:** exact standalone visitor chat routes and the queryless widget embed now permit same-origin microphone access; all other ordinary pages continue to deny it. The widget delegates only `microphone`, and Voice Mode still requires an explicit visitor action, browser consent, server availability, entitlement, quota, and provider authorization. Permission or connection failures preserve text chat and expose a working retry action.
- **New — conversation intelligence and knowledge workflow:** durable structured insights, low-confidence and knowledge-gap detection, grouped operational events, evidence-separated knowledge proposals, and an admin review page. Approval deliberately does not publish canonical knowledge.
- **New — operational event center:** channel-neutral events, severity, deduplication/grouping, occurrence counts, acknowledgement/resolution, linked evidence, and AI Operations dashboard integration.
- **Improved — human questions and evaluations:** expanded question types/metadata and durable callbacks; evaluation regression comparison now emits operational events. The existing venue/model/config evaluation framework was retained rather than rebuilt.
- **New — safe visitor feedback and location foundations:** message-scoped helpful/not-helpful feedback, verified stable floor/location/connection IDs, public resolver, entitlement checks, and unsafe map-reference rejection.
- **Improved — visitor actions and chat:** typed action targets, URL/phone validation, confirmation metadata, click analytics without sensitive targets, feedback controls, route/message IDs, and polished voice/error states.
- **Validated and hardened — employee access, widget, and partner API:** existing public/employee/admin retrieval boundaries and authenticated employee layer were preserved; widget now requires entitlement; existing versioned tenant-scoped partner API architecture was documented.
- Canonical architecture documentation: `docs/launch-capability-architecture.md`.

Important implementation areas include `packages/ai/src/capability-routing.ts`, `packages/ai/src/realtime-voice.ts`, `packages/db/src/helpers/product-entitlements.ts`, `packages/db/src/helpers/voice-session-recovery.ts`, `packages/db/src/helpers/operational-events.ts`, `packages/api/src/routers/voice.ts`, `apps/workers/src/processors/voice-session-recovery.ts`, `packages/api/src/routers/admin/attention-console.ts`, `apps/web/components/VoiceControl.tsx`, and `apps/dashboard/components/admin/KnowledgeProposalReview.tsx`.

## Partially completed

- Realtime voice is implemented end to end in code and mocks, but no paid provider call was made because a real provider credential and venue entitlement were intentionally not assumed.
- Statements in the earlier Tochi character-system QA packet that the app universally denies microphone access describe the pre-transport state and are superseded by this narrowly scoped Voice Mode boundary. They remain useful history, not current runtime policy.
- Conversation intelligence currently creates deterministic low-confidence/gap records. Broader asynchronous intent, sentiment, complaint, and accessibility classification can reuse the same schema.
- Location V1 has schema and a safe resolver, but no client authoring UI, map renderer, or turn-by-turn navigation.
- Notification delivery records are channel-neutral; email, SMS, push, and Slack delivery adapters are not implemented. Grouping and acknowledgement exist; per-event-type mute preferences do not.
- Entitlement administration is available through admin procedures; a broad pricing/paywall or client-plan UI was intentionally not added.
- The existing partner API remains the external API surface. The new `api` entitlement is not yet commercial enforcement for every existing credential path.

## Not started

- Audio retention/recording (intentionally excluded by default).
- Indoor turn-by-turn navigation or model-authored routes.
- Autonomous knowledge publication.
- External notification delivery channels.
- Final billing/pricing UX and advanced client controls for all capabilities.

## Migrations

- `20260819140000_add_product_entitlements` — plan capabilities and append-only overrides.
- `20260819141000_add_ai_route_observability` — capability/route/fallback usage evidence.
- `20260819142000_add_realtime_voice_foundation` — voice sessions and transcript segments.
- `20260819143000_add_conversation_intelligence` — structured conversation insights.
- `20260819144000_add_operational_event_center` — events and delivery attempts.
- `20260819145000_add_knowledge_change_proposals` — reviewable, non-publishing proposals.
- `20260819150000_add_location_intelligence_v1` — floors, locations, and connections.
- `20260819151000_preserve_existing_widget_plans` — compatibility mapping for existing widget tiers.
- `20260819152000_add_multimodal_ai_usage` — audio units and provider request deduplication.
- `20260819153000_add_voice_usage_rollups` — daily audio aggregation.
- `20260819154000_add_message_feedback` — tenant/session/message-scoped feedback.
- `20260819155000_expand_agent_questions` — typed questions, urgency, evidence, and callbacks.

All 122 repository migrations applied successfully to the exact-name disposable local-staging PostgreSQL database; Prisma reports the schema is current.

## Configuration

- `VOICE_MODE_ENABLED=false`
- `OPENAI_API_KEY` (server-only; existing variable, required for live OpenAI realtime authorization)
- `OPENAI_REALTIME_PREMIUM_MODEL=gpt-realtime-2.1`
- `OPENAI_REALTIME_ECONOMY_MODEL=gpt-realtime-2.1-mini`
- `OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-live-transcribe`

Model identifiers are configuration defaults, not application-level coupling.

## Feature flags

- Voice remains disabled by default and additionally requires the `voice` entitlement. Premium routing also requires `premium-voice`.
- Widget retains its existing default-off environment gate and now additionally requires the `widget` entitlement.
- New plan tiers fail closed. Existing widget plan tiers receive the compatibility mapping from the migration.
- Location resolution requires `location-plus`. `knowledge-automation` and `employee-mode` capability IDs are available for rollout wiring; the existing employee layer continues to rely on authenticated tenant membership and its venue-scoped access key.

## Tests

- `pnpm test`: all 23 Turbo tasks passed; script tests reported 164 passed and 1 intentionally skipped fixture.
- `pnpm typecheck`: 23/23 tasks passed.
- `pnpm lint`: 13/13 tasks passed with one pre-existing `PlaceCard.tsx` `no-img-element` warning and no errors.
- Production builds for dashboard, web, workers, and packages passed during the client-bundle secret gate.
- Prisma schema validation, native client generation, and disposable migration status passed.
- Boundary gates passed for AI providers/budgets, raw SQL, tenant bypasses/procedures/registry, public surfaces, and browser-deliverable secret scanning.
- Browser inspection passed on desktop and 390×844 mobile visitor fixtures after fixing the fixture's missing tRPC provider boundary. Local staging health reports database and queue up; provider-executing workers remain disabled.

## Risks / follow-up

- Run a credentialed voice smoke in an explicitly entitled non-production venue and verify browser/provider compatibility across target Safari and Android versions.
- Add an admin authoring/import flow for verified location records before exposing map actions broadly.
- Add delivery adapters and mute preferences only after channel policy and escalation ownership are defined.
- Expand conversation classifiers from the deterministic gap signal using the `BACKGROUND_ANALYSIS` route and bounded budgets.
- Decide whether existing partner API credentials should require `api` entitlement before enabling commercial plan enforcement.

## Manual actions required

1. Review and deploy the twelve forward migrations through the approved deployment workflow.
2. Configure the server-side OpenAI key and verify realtime account/model access; never place the key in browser configuration.
3. Set voice model mappings if the documented defaults are not desired.
4. Grant `voice` (and optionally `premium-voice`) to a test venue, then set `VOICE_MODE_ENABLED=true` only in the intended environment.
5. Configure widget origins and the existing widget environment gate before granting `widget` to new venues.
6. Perform the live provider/browser smoke and review usage/cost events before broader rollout.

No external account, credential, production migration, entitlement, or deployment was changed by this implementation.
