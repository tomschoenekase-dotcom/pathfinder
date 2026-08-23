# Client visitor pulse

The client portal exposes a small, venue-scoped visitor pulse for live and paused venues. It is a service surface, not a traditional analytics dashboard: clients see recent aggregate usage and can ask the Torchiko team to review the visitor experience without learning an internal configuration system.

## Read boundary

`portal.getVenueVisitorPulse` first proves that the requested venue belongs to the active tenant, then returns only a fixed 30-day aggregate:

- count of public visitor conversations;
- helpful and not-helpful rating counts.

It does not return visitor identifiers, locations, message content, rating reasons, transcripts, provider/model data, inferred themes, or unreviewed conversation insights. Employee-only conversations are excluded. A missing or cross-tenant venue fails before aggregate reads.

## Correction path

“Ask for a review” opens a new, venue-scoped Support draft categorized as `CONTENT_CORRECTION`. Existing support conversations remain intact, and the client supplies the actual observation before sending. Submission uses the existing idempotent, audited Support action; it does not publish or mutate venue content.

## Deliberate limits

- No raw client chat-log access.
- No automatic publication or content edit.
- No claim that an unrated answer was helpful.
- No cross-venue rollup; each venue stays explicit even for multi-venue organizations.
- No production or staging activation is implied by this local implementation.

The visual fixture at `/dev-fixtures/portal-home?state=live` supplies deterministic aggregate values for desktop and mobile QA.
