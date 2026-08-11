import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811200000_add_normalized_universal_content/migration.sql',
  ),
  'utf8',
)

const typedTables = [
  'service_content',
  'policy_content',
  'event_content',
  'operational_fact_content',
  'relationship_content',
] as const

describe('normalized universal content migration contract', () => {
  it('uses separate typed tables and never introduces a generic item or payload blob', () => {
    for (const table of typedTables) expect(migration).toContain(`CREATE TABLE "${table}"`)
    expect(migration).not.toMatch(/CREATE TABLE "(?:content_items|universal_content_items)"/i)
    expect(migration).not.toMatch(/"(?:payload|blob)"\s+(?:JSON|JSONB|BYTEA)/i)
    expect(migration).not.toMatch(/INSERT INTO|UPDATE\s+"(?:places|venue_knowledge_entries)"/i)
  })

  it('pins every record to exact tenant and venue scope', () => {
    expect(migration).toContain(
      'FOREIGN KEY ("module_id", "tenant_id", "venue_id", "kind") REFERENCES "content_module_identities"',
    )
    for (const table of typedTables) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_revision_scope_fkey" FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind")`,
      )
    }
    expect(migration).toContain(
      'FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_kind") REFERENCES "content_module_revisions"',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("place_id", "tenant_id", "venue_id") REFERENCES "places"',
    )
  })

  it('enforces relationship endpoint scope, identity, and non-self linkage', () => {
    expect(migration).toContain('CHECK ("from_module_id" <> "to_module_id")')
    expect(migration).toContain(
      'FOREIGN KEY ("from_module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("to_module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"',
    )
  })

  it('makes identities, revisions, typed payloads, and evidence append-only', () => {
    for (const stem of [
      'content_module_identities',
      'content_module_revisions',
      ...typedTables,
      'content_module_evidence',
    ]) {
      expect(migration).toContain(`${stem}_append_only`)
      expect(migration).toContain(`${stem}_no_truncate`)
    }
    expect(migration).toContain('"excerpt_hash" ~ \'^[a-f0-9]{64}$\'')
  })
})
