import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('prospect follow-up lineage migration', () => {
  it('caps sequences at two and preserves originating send, member, draft, and human policy lineage', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260822110000_add_prospect_followup_lineage/migration.sql',
      ),
      'utf8',
    )
    expect(migration).toContain('"sequence_number" BETWEEN 1 AND 2')
    expect(migration).toContain('"campaign_member_id"')
    expect(migration).toContain('"trigger_send_item_id"')
    expect(migration).toContain('"draft_id"')
    expect(migration).toContain('"policy_approved_by"')
    expect(migration).toContain('prospect_followups_campaign_member_id_sequence_number_key')
  })
})
