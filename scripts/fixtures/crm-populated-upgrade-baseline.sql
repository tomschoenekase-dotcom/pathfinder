-- Synthetic pre-canonicalization CRM state for populated upgrade rehearsals.
-- Apply only after migrations through 20260820021500_add_prospect_outreach_operations.
-- All identities use reserved upgrade-* values and example.test addresses.

INSERT INTO tenants (id, name, slug, updated_at)
VALUES ('upgrade-tenant', 'Upgrade Tenant', 'upgrade-tenant', CURRENT_TIMESTAMP);

INSERT INTO venues (id, tenant_id, name, slug, updated_at)
VALUES ('upgrade-live-venue', 'upgrade-tenant', 'Upgrade Live Venue', 'upgrade-live-venue', CURRENT_TIMESTAMP);

INSERT INTO prospect_organizations
  (id, canonical_name, normalized_name, normalized_domain, source, owner_id, priority, tags, created_by, updated_by, updated_at)
SELECT
  'upgrade-org-' || g,
  'Upgrade Organization ' || g,
  'upgrade organization ' || g,
  'venue' || g || '.example.test',
  'production-like-upgrade-fixture',
  'legacy-owner',
  'LOW',
  CASE WHEN g % 2 = 0 THEN '["museum","priority"]'::jsonb ELSE '["gallery"]'::jsonb END,
  'legacy-import',
  'legacy-import',
  CURRENT_TIMESTAMP - (g || ' seconds')::interval
FROM generate_series(1, 20000) g;

INSERT INTO prospect_venues
  (id, organization_id, name, normalized_name, city, region, stage, priority, next_action, next_action_at, created_by, updated_by, updated_at)
SELECT
  'upgrade-prospect-venue-' || g,
  'upgrade-org-' || g,
  'Upgrade Venue ' || g,
  'upgrade venue ' || g,
  'Chicago',
  'IL',
  'DISCOVERED',
  'LOW',
  'legacy venue action',
  CURRENT_TIMESTAMP + interval '30 days',
  'legacy-import',
  'legacy-import',
  CURRENT_TIMESTAMP
FROM generate_series(1, 20000) g;

INSERT INTO prospect_contacts
  (id, organization_id, venue_id, "fullName", email, normalized_email, source, do_not_contact, suppression_reason, created_by, updated_by, updated_at)
SELECT
  'upgrade-contact-' || g,
  'upgrade-org-' || g,
  'upgrade-prospect-venue-' || g,
  'Contact ' || g,
  'contact' || g || '@example.test',
  'contact' || g || '@example.test',
  'legacy-import',
  g % 100 = 0,
  CASE WHEN g % 100 = 0 THEN 'legacy request' END,
  'legacy-import',
  'legacy-import',
  CURRENT_TIMESTAMP
FROM generate_series(1, 20000) g;

INSERT INTO prospect_opportunities
  (id, organization_id, stage, owner_id, priority, next_action, next_action_at, source, created_by, updated_by, updated_at)
SELECT
  'upgrade-opportunity-' || g,
  'upgrade-org-' || g,
  'READY_FOR_OUTREACH',
  'canonical-owner',
  'HIGH',
  'canonical next action',
  CURRENT_TIMESTAMP + interval '7 days',
  'legacy-import',
  'legacy-import',
  'legacy-import',
  CURRENT_TIMESTAMP
FROM generate_series(1, 20000) g;

INSERT INTO prospect_stage_history (id, opportunity_id, to_stage, reason, actor_id, evidence)
SELECT
  'upgrade-stage-' || g,
  'upgrade-opportunity-' || g,
  'READY_FOR_OUTREACH',
  'fixture transition',
  'legacy-import',
  '{"source":"upgrade"}'::jsonb
FROM generate_series(1, 20000) g;

INSERT INTO prospect_conversions
  (id, organization_id, prospect_venue_id, tenant_id, venue_id, actor_id, evidence)
VALUES
  ('upgrade-conversion-1', 'upgrade-org-1', 'upgrade-prospect-venue-1', 'upgrade-tenant', 'upgrade-live-venue', 'legacy-operator', '{"source":"legacy"}'::jsonb);

INSERT INTO prospect_outreach_campaigns
  (id, name, cohort_snapshot, playbook_version, created_by, updated_by, updated_at)
VALUES
  ('upgrade-campaign', 'Upgrade campaign', '{"fixture":true}'::jsonb, 'legacy-playbook', 'legacy-operator', 'legacy-operator', CURRENT_TIMESTAMP);

INSERT INTO prospect_campaign_members
  (id, campaign_id, organization_id, venue_id, contact_id, status, updated_at)
SELECT
  'upgrade-member-' || g,
  'upgrade-campaign',
  'upgrade-org-' || g,
  'upgrade-prospect-venue-' || g,
  'upgrade-contact-' || g,
  'APPROVED',
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_outreach_drafts
  (id, campaign_id, member_id, organization_id, venue_id, contact_id, status, to_email, subject, text_body, content_hash, grounding_snapshot, generated_by_type, generated_by_id, approved_by, approved_at)
SELECT
  'upgrade-draft-' || g,
  'upgrade-campaign',
  'upgrade-member-' || g,
  'upgrade-org-' || g,
  'upgrade-prospect-venue-' || g,
  'upgrade-contact-' || g,
  'APPROVED',
  'contact' || g || '@example.test',
  'Upgrade subject ' || g,
  'Frozen legacy body ' || g,
  repeat('a', 64),
  '{"fixture":true}'::jsonb,
  'HUMAN',
  'legacy-operator',
  'legacy-operator',
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_send_batches
  (id, campaign_id, status, recipient_count, snapshot_hash, created_by, approved_by, approved_at, updated_at)
VALUES
  ('upgrade-batch', 'upgrade-campaign', 'APPROVED', 1000, repeat('b', 64), 'legacy-operator', 'legacy-operator', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO prospect_send_items
  (id, batch_id, member_id, draft_id, status, recipient_email_snapshot, subject_snapshot, content_hash_snapshot, idempotency_key, provider_message_id, updated_at)
SELECT
  'upgrade-item-' || g,
  'upgrade-batch',
  'upgrade-member-' || g,
  'upgrade-draft-' || g,
  'DELIVERED',
  'contact' || g || '@example.test',
  'Upgrade subject ' || g,
  repeat('a', 64),
  'upgrade-idempotency-' || g,
  'legacy-provider-message-' || g,
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_email_threads
  (id, organization_id, venue_id, contact_id, subject, reply_token_hash, last_message_at, updated_at)
SELECT
  'upgrade-thread-' || g,
  'upgrade-org-' || g,
  'upgrade-prospect-venue-' || g,
  'upgrade-contact-' || g,
  'Upgrade subject ' || g,
  md5('reply-' || g) || md5('reply-' || g),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_email_messages
  (id, thread_id, organization_id, venue_id, contact_id, send_item_id, direction, status, provider_message_id, internet_message_id, from_address, to_addresses, subject, text_body, occurred_at)
SELECT
  'upgrade-message-' || g,
  'upgrade-thread-' || g,
  'upgrade-org-' || g,
  'upgrade-prospect-venue-' || g,
  'upgrade-contact-' || g,
  'upgrade-item-' || g,
  'OUTBOUND',
  'DELIVERED',
  'legacy-email-message-' || g,
  '<upgrade-' || g || '@example.test>',
  'legacy-mailbox@example.test',
  ARRAY['contact' || g || '@example.test'],
  'Upgrade subject ' || g,
  'Legacy correspondence ' || g,
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_email_events
  (id, send_item_id, email_message_id, provider_event_id, event_type, payload, occurred_at)
SELECT
  'upgrade-event-' || g,
  'upgrade-item-' || g,
  'upgrade-message-' || g,
  'legacy-event-' || g,
  'delivered',
  '{"fixture":true}'::jsonb,
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;

INSERT INTO prospect_email_webhook_receipts
  (id, provider, provider_event_id, event_type, payload, processed_at)
SELECT
  'upgrade-receipt-' || g,
  'resend',
  'legacy-receipt-' || g,
  'email.delivered',
  '{"fixture":true}'::jsonb,
  CURRENT_TIMESTAMP
FROM generate_series(1, 1000) g;
