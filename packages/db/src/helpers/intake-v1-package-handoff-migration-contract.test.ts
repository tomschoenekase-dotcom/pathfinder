import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('intake V1 package handoff migration', () => {
  it('pins scoped immutable revision, selected member, and DRAFT package evidence', async () => {
    const sql = await readFile(
      resolve(
        __dirname,
        '../../prisma/migrations/20260907022600_add_intake_v1_package_handoffs/migration.sql',
      ),
      'utf8',
    )
    for (const value of [
      'CREATE TABLE "intake_v1_package_handoffs"',
      'intake_v1_package_handoffs_revision_scope_fkey',
      'intake_v1_package_handoffs_package_scope_fkey',
      'selected members are invalid',
      "p.status='DRAFT'",
      'p.draft_key=NEW.operation_id',
      'append_only',
      'no_truncate',
    ])
      expect(sql).toContain(value)
  })
})
