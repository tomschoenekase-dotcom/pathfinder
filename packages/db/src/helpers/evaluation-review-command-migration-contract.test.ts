import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812000600_evaluation_review_commands/migration.sql',
  ),
  'utf8',
)

describe('evaluation review command migration', () => {
  it('adds paired UUID/hash replay evidence without inventing historical command identity', () => {
    expect(migration).toContain('ADD COLUMN "submission_operation_id" UUID')
    expect(migration).toContain('ADD COLUMN "submission_input_hash" CHAR(64)')
    expect(migration).toContain('"submission_operation_id" IS NULL')
    expect(migration).toContain('^[0-9a-f]{64}$')
    expect(migration).toContain('eval_reviews_tenant_submission_operation_key')
    expect(migration).not.toMatch(/UPDATE\s+"eval_reviews"/u)
  })
})
