# Prospect CRM and outreach operations

Status: implemented, provider-dark by default (2026-08-20)

## Operator model

The platform CRM is the pre-customer system of record. A prospect remains platform-owned until an explicit `ProspectConversion` links it to a tenant and optional live venue. Conversion does not discard prospect research, activities, campaign membership, or correspondence.

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
7. Only when `PROSPECT_OUTREACH_DELIVERY_ENABLED=true` and the provider is configured are per-recipient jobs enqueued.

The worker reloads all authoritative content from Postgres. Queue payloads contain only the send-item ID. Before provider access, it rechecks batch authority, frozen content hash, current contact email, and current suppression status. Each item uses a durable provider idempotency key and stores the provider message ID. Provider failures are durable and retryable. No live send is enabled by this implementation.

## Correspondence synchronization

Outbound delivery creates a CRM thread, message, activity, stage transition to `CONTACTED`, and a first follow-up due 13 days later. The email uses a cryptographically derived per-thread reply address when reply configuration is present.

The Resend webhook endpoint verifies the raw body with its Svix signature before any write. It stores an idempotent receipt for replay and audit. Delivery, delay, bounce, complaint, suppression, and failure events update the send item and CRM message. Bounce, complaint, and suppression events mark the contact do-not-contact.

Inbound `email.received` events retrieve the full message through Resend's Receiving API. The worker matches the cryptographic reply token, stores bounded text/HTML and attachment metadata (not attachment bytes), moves the opportunity to `REPLIED`, cancels pending no-response follow-ups, and appends the activity. Unmatched inbound mail remains represented by the webhook receipt but is not attached to an arbitrary prospect.

## Unified intelligence

The prospect intelligence read returns prospect research and relationship data. If converted, it also resolves the linked live Torchiko venue and up to 100 active places/exhibits plus 100 enabled knowledge entries under the exact tenant/venue scope. Both the admin detail screen and agent read tool use this model.

## Configuration

All variables are optional and delivery defaults off:

```text
RESEND_API_KEY=
RESEND_FROM_EMAIL=
RESEND_WEBHOOK_SECRET=
PROSPECT_OUTREACH_DELIVERY_ENABLED=false
PROSPECT_OUTREACH_REPLY_DOMAIN=
PROSPECT_OUTREACH_REPLY_SECRET= # at least 32 characters
```

`RESEND_WEBHOOK_SECRET` must be the signing secret for the Resend webhook endpoint. Configure the provider webhook for email delivery lifecycle events and `email.received`. `PROSPECT_OUTREACH_REPLY_DOMAIN` must be a verified receiving domain. Keep delivery disabled until provider-domain verification, webhook replay tests, and a controlled internal-recipient smoke test have been approved.

## Deliberate limitations

- Attachments are metadata-only. Their temporary provider download URLs are not fetched or persisted.
- The current UI stages at most 500 recipients per release and campaigns at most 5,000 members.
- Email generation itself is performed by an external/internal agent using the registry; the UI does not silently invoke a model.
- Provider configuration, real delivery, domain verification, and a live smoke test were not authorized and were not performed.
