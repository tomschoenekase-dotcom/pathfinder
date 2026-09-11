import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260907021800_add_prospect_onboarding_delivery_attempts/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('prospect onboarding delivery attempt migration', () => {
  it('requires exact current positive reply, venue, contact, and normalized recipient scope', () => {
    expect(sql).toContain(
      "message.inbound_reply_review_id=review.id AND review.disposition='POSITIVE_INTEREST'",
    )
    expect(sql).toContain('message.venue_id=NEW.prospect_venue_id')
    expect(sql).toContain('message.contact_id=NEW.contact_id')
    expect(sql).toContain('contact.venue_id IS NULL OR contact.venue_id=message.venue_id')
    expect(sql).toContain(
      'lower(contact.normalized_email)=lower(btrim(NEW.recipient_email_snapshot))',
    )
  })

  it('is provider-dark, draft-only, uniquely replayable, and immutable', () => {
    expect(sql).toContain("AS ENUM ('DRAFT')")
    expect(sql).toContain('positive-interest:')
    expect(sql).toContain('"source_message_id", "prospect_venue_id"')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "prospect_onboarding_delivery_attempts"')
    expect(sql).not.toMatch(/provider_(?:message|operation|delivery)_id/u)
  })
})
