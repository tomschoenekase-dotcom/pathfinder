# Prospect CRM and outreach operations

Status: architectural correction in progress; delivery dark (2026-08-20)

> This document originally described the pre-correction Resend prospect runtime. `ADR-CRM-CANONICALIZATION-2026-08-20` supersedes that provider and state-ownership design. Historical wording is corrected below rather than treated as current capability.

## Operator model

Postgres is the sole writable CRM system of record. An organization-level `ProspectCustomerRelationship` links a prospect organization to a tenant; child `ProspectLocationConversion` records link any number of prospect locations to live venues over time. Conversion does not discard prospect research, activities, campaign membership, or correspondence.

The directory supports server-side search and filters for lifecycle stage, operational priority, relationship tier, email readiness, and next-action state. Results use cursor pagination in 100-row pages. Operators can save named filter definitions and select an exact set of prospect IDs to create a campaign. A campaign stores both those IDs and the filter snapshot used to reach them.

## Authority boundary

The dedicated prospect agent registry exposes:

- `torchiko.prospects.search`
- `torchiko.prospects.get_intelligence`
- `torchiko.prospects.list_campaign_members`
- `torchiko.prospects.save_outreach_draft`

It exposes no approve, queue, or send tool. A verified `prospects:read` or `prospects:draft` capability is required. This separate platform surface avoids weakening the existing tenant-owned agent identity boundary.

Drafts are versioned. Saving a revision supersedes the prior editable revision. Every draft freezes its recipient address, content hash, grounding snapshot, generator identity, playbook version (through its campaign), and escalation flags. Unresolved template placeholders are rejected.

Pricing, travel, scheduling commitments, custom commitments, and strategic prospects are flagged. A human platform administrator must explicitly acknowledge every flag before approval. Approval freezes the draft.

## Release workflow

1. Operator or capable agent creates a draft.
2. Human reviews and freezes it.
3. Human selects approved drafts and stages an exact batch.
4. The database freezes recipient count, each recipient/content snapshot, and a whole-batch hash.
5. Human approves that exact count and hash. This does not send.
6. Human performs a separate final release with the same count and hash.
7. Final release atomically creates immutable outbox operations and the batch transition. Queue publication occurs only after commit and can be recovered from the outbox.

The worker reloads only a frozen outbox operation from Postgres. Queue payloads contain only the outbox ID. Before provider access it obtains an exclusive expiring lease and rechecks global, mailbox, campaign, identity, permission, unsubscribe, and suppression state. Ambiguous provider acceptance is terminal pending reconciliation rather than blindly retried. The production Gmail OAuth/client composition root is not mounted, so no live send is enabled by this implementation.

## Correspondence synchronization

The former prospect Resend webhook returns HTTP 410 and performs no write. Resend remains only in separate transactional/opted-in product paths.

The Gmail inbound domain service persists a namespaced receipt before provider retrieval, matches provider threads plus RFC references and verified participants, bounds and marks external content untrusted, quarantines ambiguity, limits reply effects to the matched campaign member, and commits a history cursor only after a whole page is durable. Production Prisma persistence, authenticated Pub/Sub routing, OAuth, watch renewal, and scheduled reconciliation are still blocking integration work.

## Unified intelligence

The prospect intelligence read returns prospect research and relationship data. If converted, it also resolves the linked live Torchiko venue and up to 100 active places/exhibits plus 100 enabled knowledge entries under the exact tenant/venue scope. Both the admin detail screen and agent read tool use this model.

## Configuration

All variables are optional and delivery defaults off:

```text
CRM_PROSPECT_OUTREACH_ENABLED=false
PROSPECT_OUTREACH_DELIVERY_ENABLED=false
GOOGLE_CLOUD_PROJECT_ID=
GMAIL_OAUTH_REDIRECT_URI=
GMAIL_PUBSUB_TOPIC=
GMAIL_PUBSUB_PUSH_AUDIENCE=
GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT=
GMAIL_WATCH_RENEWAL_ENABLED=false
GMAIL_RECONCILIATION_ENABLED=false
```

Keep the feature flag, environment kill switch, database global switch, and mailbox switch disabled until the production Gmail composition root and all internal-email gates are complete.

## Deliberate limitations

- Attachments are metadata-only. Their temporary provider download URLs are not fetched or persisted.
- The current UI stages at most 500 recipients per release and campaigns at most 5,000 members.
- Email generation itself is performed by an external/internal agent using the registry; the UI does not silently invoke a model.
- Production Gmail persistence/OAuth/Pub/Sub/scheduler wiring, real delivery, domain verification, and a live smoke test are not complete and were not performed.
