# Venue recommendations (packet W08, acceptance A18/A19)

A small, per-venue capability that lets the guest guide mention one catalog item (for example the
lemonade) a little more often when it genuinely fits, and then reports whether it helped. It is
deliberately not a prompt that appends sales copy: eligibility, ranking, and disclosure are
deterministic server code, and the model only receives the resulting constraints.

The capability is **OFF by default**. A venue has it only when a `VenueRecommendationPolicy` row
exists with `enabled = true`. Without that row the guest path is byte-for-byte unchanged and no
catalog table is read.

## Model

Three tenant-scoped tables (all registered in `TENANTED_TABLES`; migration
`20261002100000_add_venue_recommendations`). Existing typed `ITEM` content revisions were not
reused: they are admin-governed, published through an append-only ledger and projected into search,
and have no place for freshness, availability observations, verified allergen state, or a
separate operator-only column. A minimal catalog was added instead; it does not model orders,
inventory, carts, or payments.

- `VenueCatalogItem` holds only guest-safe facts: stable key, name, description, category
  (`cold_drink`, `hot_drink`, `snack`, `meal`, `other`), optional route place and note, price in
  minor units with currency, size, price observation time, effective dates, `availability`
  (`AVAILABLE`/`UNAVAILABLE`/`UNKNOWN`) with `availabilityObservedAt`, serving hours (IANA time
  zone plus weekly windows) and seasonal windows, ingredients, allergens and dietary flags, sources,
  `lastVerifiedAt`, `allowedClaims`, and an integer `version` used for optimistic concurrency.
  Ingredients and allergens are `{status: 'known' | 'unknown', values}`: `unknown` is never the same
  as a verified empty list. Unreadable stored values are treated as `unknown`.
- `VenueCatalogItemPriority` holds the private commercial priority (`LOW`/`NORMAL`/`HIGH`) in its own
  table with `audience = OPERATOR` (a database CHECK pins it). No guest-context loader selects it
  with the facts; the ranking function consumes it and never copies it into its output.
- `VenueRecommendationPolicy` is the versioned per-venue policy: `enabled`, `maxBoost` (0 to 10),
  `maxUnsolicitedPerSession` (1 to 3, default 1), fact and availability freshness windows, `expiresAt`,
  and an owner. The cap of 1 is a **proposed test setting**, not an approved business decision.
  The policy is stored separately from facts. Each update increments `version`; the before and
  after state of every change is written to the audit log.

## Decision flow

Implemented in `packages/api/src/lib/venue-recommendation.ts` (pure, no model calls, no clock
reads, no database).

1. Capability gate: no enabled policy means no behavior. An expired policy stops all featuring.
2. Hard eligibility per item, before any ranking: item belongs to the venue; not archived; within
   its effective dates; facts verified and no older than `factMaxAgeDays`; price observed and not
   stale; availability `AVAILABLE` and observed within `availabilityMaxAgeHours` (unknown, stale,
   and unavailable are all excluded); inside serving hours and season; within a guest-stated
   budget; compatible with the guest's stated allergies and dietary needs. Allergies and dietary
   needs persist across the session's earlier messages. An item with unknown allergens is never safe
   for a guest who mentioned an allergy, and a dietary need requires an explicit verified `yes`.
3. Relevance: only a request for a drink or refreshment ("thirsty", "something cold", a cafe or
   drink question) is a candidate for an unsolicited suggestion. Safety, accessibility,
   directions, history, and unrelated exhibit questions never are.
4. Usefulness ranking on a 0 to 100 scale (category fit, a "cheapest" request, verified dietary
   matches), then a bounded commercial tie-break: only `HIGH`-priority items get a boost, never more
   than `maxBoost` points. A usefulness lead larger than the bound cannot be overturned, so the
   cheapest drink wins when the guest asked for the cheapest. Only a `HIGH` item that wins this
   ranking may be featured; otherwise nothing is featured.
5. Session limits: a refusal ("no thanks", "stop suggesting") is honored for the rest of the session;
   `maxUnsolicitedPerSession` caps unprompted mentions; an item is not repeated.
6. A direct question that names an item always gets a truthful answer, regardless of refusal, cap, or
   policy expiry. The facts passed to the model state unavailable, closed, out of season, unverified
   price, and unknown allergens plainly, and no pitch or disclosure is added.

Output: shown recommendation or none, alternatives, exclusion reasons per item, policy id and
version, candidate ids, the disclosure text, and the allowed claim text.

## Guest answer integration

`chat.send` (public experience scope only) loads the decision after retrieval and before prompt
assembly (`venue-recommendation-context.ts`), and `renderRecommendationPromptBlock` appends a
labelled `VENUE RECOMMENDATION DECISION` block after the retrieved-data section. The block is one of
`FEATURE_ONE_ITEM`, `ANSWER_DIRECT_QUESTION`, or `NO_PROACTIVE_RECOMMENDATION`. Venue-authored text
is escaped and fenced as untrusted data. The block carries only guest-safe facts, and a test
asserts that the private priority, the boost, and the policy tuning never appear in the decision,
the block, or the prompt, and that the rest of the prompt is unchanged.

- Disclosure: when a featured item is surfaced the answer carries the line `Featured by <venue>`.
  The model is told to include it, and the server appends it deterministically if the model
  mentions the item without it.
- Claims: no health, popularity, scarcity, urgency, savings, or superlative claims are allowed
  unless the exact text is in the item's `allowedClaims`.
- Failure: any error loading recommendation state fails open to a normal answer.

## Analytics and measurement

Three new server-only events (`packages/analytics/src/events.ts`), none in the public-client
allow-list, written best-effort after the turn is committed and only for non-fallback answers:

- `recommendation.candidate`: an eligible item existed for a refreshment request (records candidate
  ids and, if not shown, the reason).
- `recommendation.shown`: the final answer actually surfaced the featured item (item id and version,
  policy id and version, candidate count, whether the tie-break decided, whether the disclosure was
  appended). The event is also the per-session counter the cap reads.
- `recommendation.declined`: the guest declined suggestions.

Clicks reuse existing public events: a place-card click, a directions open, or a place-targeted
`visitor.action.clicked` on the item's route place after exposure in the same session.

`venueRecommendation.getMeasurement` returns raw counts only: eligible sessions, sessions and events
shown, declined sessions, shown sessions with a click, and, as a comparison, eligible sessions where
nothing was shown that had a click on an item place.

### Measurement limits

- **Sales attribution is unavailable.** There is no point-of-sale link, so there is no revenue,
  conversion, lift, or ROI figure, and none is invented. The response carries
  `salesAttribution: 'unavailable'` and an explicit note, and the dashboard shows it.
- Clicks are only measurable for items with a linked route place. Menu opens inside the venue
  and purchases are invisible to PathFinder.
- The comparison between shown and not-shown sessions is observational, not a controlled
  experiment: sessions are not randomly assigned, and not-shown sessions differ for reasons (cap,
  refusal, ineligibility).
- Reads are capped at 50,000 events per window and flag truncation.

## Operator surface

`venueRecommendation` tRPC router (`packages/api/src/routers/venue-recommendation.ts`):
`getOverview`, `upsertItem`, `archiveItem`, `setItemPriority`, `upsertPolicy` (MANAGER or stricter) and
`getMeasurement` (STAFF or stricter). Every procedure is a `tenantProcedure` that resolves the venue
from the session tenant first, writes through version-checked `updateMany`, and audits through
`writeAuditLogStrict`. All six have generated cross-tenant cases. The dashboard section is a
"Featured items" panel on the existing "Guide tone and answers" page (`/ai-controls`).

## Known gaps

- Voice conversations and the second-layer (employee) experience do not use the capability.
- The dashboard form does not edit serving hours, seasonal windows, ingredient lists, dietary flags,
  or sources; those are supported by the API and the ranking module.
- Intent and refusal detection is English keyword matching and will miss other languages and
  indirect phrasing. It errs toward not recommending.
- Policy history lives in the audit log (before and after state), not a separate versions table.
- The cap default of 1 and the boost bound of 3 are proposed values awaiting approval.
- Migration `20261002100000_add_venue_recommendations` is migration 256. The staging release-ledger
  pins (`scripts/run-staging-migration-predeploy.mjs`, `packages/db/src/helpers/operational-health.ts`
  and the script tests that freeze the "reviewed 255 endpoint") still describe 255 and fail until a
  reviewed staging cutover admits migration 256. They were deliberately not re-pinned here because
  that requires a new human-approved release identifier.
