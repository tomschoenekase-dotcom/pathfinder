# Launch capability architecture

This document is the canonical guide for PathFinder's launch-adjacent capability layer. All tenant-scoped records use composite tenant/venue relations or an authoritative server-side scope lookup. Experimental public controls remain hidden until both their environment gate and product entitlement allow them.

## AI capability routing and metering

Application code requests a capability from `packages/ai/src/capability-routing.ts`; workload configuration chooses an ordered, provider-neutral route. Current capabilities include fast and standard conversation, reasoning, premium conversation, realtime voice tiers, extraction, classification, embeddings, moderation, and background analysis. Runtime workload configuration still supports platform, tenant, and venue overrides. Provider/model health, disabled routes, cost policy, quality preference, and fallback ordering are inputs to route planning.

Live guest chat executes the complete centrally configured route rather than selecting only its
first candidate. Gateway failures may move to an explicit fallback under the same invocation and
one durable provider-dispatch fence. Non-provider failures—including admission, budget, policy,
accounting, and abort controls—fail closed and cannot trigger a second candidate. The route model
is provider-neutral, but current text execution is Anthropic-only; cross-provider text failover is
an explicit remaining adapter and staging-verification gate.

If every configured guest-chat candidate fails and the safe visitor response is committed, a
sanitized `guest-chat.route-degraded` operational event is grouped by venue and routing version for
the Founder Control Room. A successful fallback candidate creates usage evidence but no incident.
This does not automatically disable a provider, change route health, or establish an outage-rate or
external-notification threshold.

Human platform administrators can separately record audited, expiring provider-health exclusions.
Guest chat applies one control snapshot before both embedding and response generation across all
venues. Expired exclusions restore eligibility automatically; malformed or unreadable control
fails closed. The control does not infer health or activate an unavailable provider. See
[`ai-provider-health-control.md`](ai-provider-health-control.md).

`AiUsageEvent` records tenant, venue, capability, request type, provider, model, route key, fallback use, latency, success, token/audio units, pricing version, and estimated cost. Daily rollups retain text and audio units. Do not log prompt or transcript bodies as route telemetry.

The explicitly configured tenant hard budget remains the authoritative pre-dispatch spend fence.
Denied reservations and recorded over-ceiling breaches now publish deduplicated, tenant-scoped
Founder Control Room events linked to the budget controls. This adds actionable evidence without
choosing an alert threshold, changing customer service, or enabling an external escalation channel.
See [`ai-cost-protection.md`](ai-cost-protection.md).

## Entitlements

Closed capability IDs live in `packages/contracts/src/product-entitlements.ts`. Resolution precedence is: server kill switch, active venue override, active tenant override, plan mapping, deny by default. Billing may assign a plan tier but does not own authorization. Overrides are append-only evidence and can be time-bounded trials or promotions. Platform admins use the product-entitlement procedures to inspect effective decisions, append overrides, and maintain plan mappings.

The widget and voice require separate environment gates. Existing widget plan tiers are backfilled to preserve deployed behavior; new plan tiers fail closed.

## Realtime voice

`packages/ai/src/realtime-voice.ts` is the provider boundary. The initial OpenAI adapter creates a short-lived browser credential on the server. The standard provider API key never enters browser output or persisted session data. Browser WebRTC then exchanges SDP directly with the provider.

Every `VoiceSession` is bound to tenant, venue, public visitor session, bot snapshot, locale, tier, route, entitlement source, and quota policy. Transcript segments store text only; audio is not retained. Admission rechecks concurrent, daily, and monthly quotas under a tenant/venue advisory lock. Usage reported by provider events is validated, priced on the server, and idempotently persisted.

Configuration:

- `VOICE_MODE_ENABLED=false` is the emergency rollout gate.
- `OPENAI_API_KEY` remains server-only.
- `OPENAI_REALTIME_PREMIUM_MODEL`, `OPENAI_REALTIME_ECONOMY_MODEL`, and `OPENAI_REALTIME_TRANSCRIPTION_MODEL` are non-secret model mappings.
- `voice` and, for the premium tier, `premium-voice` entitlements are required.

## Knowledge and access scopes

Trusted venue knowledge retains explicit `PUBLIC`, `EMPLOYEE`, and `ADMIN` visibility. Public chat is restricted to public content. The established second-layer employee experience requires an authenticated active tenant member, an enabled venue link, and its scoped access key; it retrieves public plus employee content. Admin content never enters either public or employee retrieval.

Conversation insights record structured category, confidence, severity, summary, suggested action, message references, analyzer route, and review status without copying entire conversations. Low-confidence public turns create durable insight and operational-event evidence.

Knowledge change proposals keep observed visitor claims, AI inference, the proposed canonical change, and evidence separate. Human approval records a decision but does not publish. Canonical knowledge can change only through an explicit future publication action with its own audit evidence.

## Operational control center and evaluations

`OperationalEvent` is the channel-neutral source of actionable alerts. It supports severity, grouping/deduplication, occurrence counts, read/acknowledged/resolved states, linked objects, and delivery attempts. High-frequency analytics do not automatically become notifications. The admin operations dashboard combines questions, agent lifecycle state, quality regressions, failures, and knowledge/cost alerts.

Agent questions support typed answers, categories, urgency, due dates, evidence, proposed answers, and callback metadata. Questions coordinate human input; they never grant approval authority.

The existing evaluation framework records venue/eval-set versions, model/provider/configuration, cases, scores, cost, latency, reviews, and reruns. Comparable completed runs detect meaningful score regressions and emit operational events. Model selection is never changed solely from cost or an automatic regression signal.

## Structured actions and locations

Guest responses use the typed `GuestVisitorAction` contract. It validates action/target combinations, public permission, confirmation needs, analytics keys, HTTPS URLs, and E.164 phone targets. Public click analytics omit raw URL and phone values.

Location intelligence uses verified stable IDs for floors, zones, rooms, POIs, entrances, exits, exhibits, amenities, accessibility points, services, parking, and connections. Public resolution requires an authoritative public session, `location-plus`, active public visibility, and verification metadata. Unsafe external map references are discarded. Models must never invent coordinates or routes.

## Widget and API readiness

The existing widget remains environment-gated, origin-policy-aware, responsive, and fail-invisible. It now also requires the `widget` entitlement. The established partner read API remains versioned, tenant-scoped, hashed/revocable, rate-limited, and audited; the `api` entitlement is available for future commercial activation without coupling authorization to billing.
