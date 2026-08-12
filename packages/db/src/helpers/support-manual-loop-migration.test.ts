import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('support manual-loop request-version migration', () => {
  it('adds nullable positive evidence paired with immutable submission identity without guessing legacy data', async () => {
    const sql = await readFile(
      new URL(
        '../../prisma/migrations/20260812000900_add_support_message_request_version/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )

    expect(sql).toContain('ADD COLUMN "request_version" INTEGER')
    expect(sql).toContain('"request_version" IS NULL')
    expect(sql).toContain('"request_version" > 0')
    expect(sql).toContain('"submission_request_id" IS NOT NULL')
    expect(sql).toContain('"submission_input_hash" IS NOT NULL')
    expect(sql).not.toMatch(/UPDATE\s+"support_messages"/i)
    expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/)
  })
})
