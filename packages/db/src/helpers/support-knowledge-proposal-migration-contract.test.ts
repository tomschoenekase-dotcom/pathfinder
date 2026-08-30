import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260825013000_link_support_knowledge_proposals/migration.sql',
  ),
  'utf8',
)

describe('support-linked knowledge proposal migration contract', () => {
  it('binds exact request-version evidence and makes the source immutable', () => {
    expect(migration).toContain('"support_request_id" TEXT')
    expect(migration).toContain('"support_request_version" INTEGER')
    expect(migration).toContain('knowledge_proposals_support_source_pair_check')
    expect(migration).toContain('knowledge_proposals_support_event_fkey')
    expect(migration).toContain('knowledge_proposals_support_version_key')
    expect(migration).toContain('knowledge_proposals_support_source_immutable')
    expect(migration).toContain('support-linked knowledge proposal source evidence is immutable')
  })
})
