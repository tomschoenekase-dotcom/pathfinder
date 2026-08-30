import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260822104500_add_prospect_research_jobs/migration.sql',
  ),
  'utf8',
)

describe('prospect research job migration', () => {
  it('retains bounded leases and append-only attempt lineage without send authority', () => {
    expect(sql).toContain('prospect_research_jobs_claim_idx')
    expect(sql).toContain('prospect_research_attempts_claim_token_key')
    expect(sql).toContain('lease_expires_at')
    expect(sql).toContain('model_provider')
    expect(sql).toContain('prompt_identity')
    expect(sql).toContain('cost_usd')
    expect(sql).not.toMatch(/prospect_send_(?:batches|outbox)/u)
  })
})
