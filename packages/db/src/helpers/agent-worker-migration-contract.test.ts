import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260821193000_add_portable_agent_workers/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('portable agent worker migration', () => {
  it('adds durable provider-neutral workers and optional run attribution', () => {
    expect(sql).toContain('CREATE TABLE "agent_workers"')
    expect(sql).toContain('"worker_key" VARCHAR(191) NOT NULL')
    expect(sql).toContain('"credential_scope_key" VARCHAR(191) NOT NULL')
    expect(sql).toContain('ALTER TABLE "agent_runs" ADD COLUMN "execution_worker_id" TEXT')
  })

  it('does not delete or rewrite existing worker/run state', () => {
    expect(sql).not.toMatch(/\bDROP\b/u)
    expect(sql).not.toContain('DELETE FROM')
  })
})
