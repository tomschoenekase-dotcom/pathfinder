import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260821194500_add_company_knowledge_embeddings/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('Company Knowledge embedding migration contract', () => {
  it('extends the shared embedding entity enum and indexes the canonical table', () => {
    expect(migration).toContain("ADD VALUE IF NOT EXISTS 'COMPANY_KNOWLEDGE'")
    expect(migration).toContain('ADD COLUMN embedding vector(1536)')
    expect(migration).toContain('USING hnsw (embedding vector_cosine_ops)')
    expect(migration).toContain('WHERE embedding IS NOT NULL')
  })
})
