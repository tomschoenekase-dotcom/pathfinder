# Optional visitor general web background

The visitor guide uses venue knowledge first. Optional web search is default-disabled and supplies general background only. It never establishes venue hours, prices, policies, accessibility, location, eligibility, or current operations.

## Authorization and configuration

The global `GUEST_GENERAL_WEB_FALLBACK_ENABLED` flag and an enabled `TenantFeatureFlag` named `guest-general-web-fallback-v1` are both required. The tenant row must contain strict metadata:

```json
{
  "venueIds": ["explicit-authorized-venue-id"],
  "allowedDomains": ["nasa.gov"],
  "modelKey": "guest-chat-openai",
  "maxOutputTokens": 768,
  "timeoutMs": 4000,
  "requestBudgetCeilingE8Usd": "20000000"
}
```

This is a configuration example, not an enabled tenant or an authorization to call a provider. Budget values are integer units of USD 0.00000001, not dollar decimals. The resolver requires exact venue membership and rejects malformed configuration. It re-reads permission immediately before dispatch; a changed or revoked configuration cancels search. No guest request field grants permission.

Search also requires public visitor scope, outbound-reference display enabled, an available OpenAI route/key, and a conservative eligible general question. Locally retrieved knowledge or a sufficiently close semantic place match suppresses search. The initial language classifier is conservative and primarily handles English question forms; it does not claim multilingual semantic coverage. Unknown intent, embedded destinations/email, control characters, unsupported script, and venue-contextual questions retain normal venue-grounded behavior.

## Provider and budget boundaries

The adapter uses the Responses `web_search` tool with an explicit domain allowlist, one tool call, no SDK retries, `store:false`, bounded query/results/output, and a hard timeout plus cancellation. Only the query is sent: no venue corpus, conversation history, coordinates, tenant IDs, or session IDs accompany it. This is a bounded eligibility check, not a guarantee that arbitrary user text contains no personal information.

The pinned `gpt-5-mini-2025-08-07` model has a 400,000-token context window. A reservation covers that full input window at the uncached rate, the configured maximum output, and one search call. The qualitative `search_context_size` setting is not treated as a numeric cost cap. Rates are pinned to the reviewed 2026-09-08 pricing: $0.25/M input tokens, $0.025/M cached input tokens, $2/M output tokens, and $0.01 per search call. Settlement uses returned input/cached/output counts and rounds the aggregate token cost upward to the ledger's E8 unit.

The search-specific ceiling is nested within the generation request's cumulative ceiling when one exists. Missing durable reservations, denied admission, or insufficient budget prevent search. Search is the first optional subcall of the existing durable `RESPONSE_GENERATION` operation; the operation is marked dispatched before search, and generation does not mark it again. Unknown provider outcomes retain conservative cost settlement and the existing ambiguous-turn replay protection. There is no automatic search retry.

## Grounding and attribution

Search text is isolated as untrusted general background. Venue-specific grounding rules remain in force. Unsafe citations, incomplete responses, unknown output shapes, oversized evidence, or inconsistent usage are rejected. Every accepted cited reference is retained; consulted-only references are not advertised as citations. Cited sources appear in the existing visible, clickable Sources block, while an immutable content-addressed evidence snapshot retains the original search text, provider/model/response identity, capture time, and query hash. That snapshot proves supplied context, not claim-level use by the final generation.

Search failure preserves the ordinary supported answer and honest knowledge gap. Provider-fallback responses do not advertise web citations. Historical answers retain their original prompt/evidence identity on replay.

## Verification boundary

Implementation tests use injected provider responses and disposable/mock accounting boundaries. No live search, production enablement, or deployment is established by those tests. Real-provider answer quality, latency, and observed billing remain separate release checks under an authorized budget.

Official references: [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [pricing](https://developers.openai.com/api/docs/pricing#tools), [GPT-5 Mini](https://developers.openai.com/api/docs/models/gpt-5-mini).
