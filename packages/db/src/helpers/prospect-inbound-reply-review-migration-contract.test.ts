import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260830165000_add_prospect_inbound_reply_reviews/migration.sql',
  ),
  'utf8',
)

describe('prospect inbound reply review migration contract', () => {
  it('retains append-only review history and one validated current-truth pointer', () => {
    expect(migration).toContain('CREATE TYPE "ProspectInboundReplyDisposition"')
    expect(migration).toContain('CREATE TABLE "prospect_inbound_reply_reviews"')
    expect(migration).toContain('prospect_inbound_reply_reviews_message_revision_key')
    expect(migration).toContain('prospect_inbound_reply_reviews_immutable')
    expect(migration).toContain('prospect_inbound_reply_reviews_no_truncate')
    expect(migration).toContain('prospect_email_messages_current_reply_review_valid')
    expect(migration).toContain('current inbound reply review must match its immutable evidence')
  })

  it('requires a human review shape only on inbound correspondence', () => {
    expect(migration).toContain('"direction" = \'INBOUND\'')
    expect(migration).toContain('"inbound_reply_disposition" IS NOT NULL')
    expect(migration).toContain('"inbound_reply_review_id" IS NOT NULL')
    expect(migration).toContain('"inbound_reply_reviewed_at" IS NOT NULL')
    expect(migration).toContain('length(btrim("inbound_reply_reviewer_id")) BETWEEN 1 AND 191')
  })
})
