import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812001600_add_universal_item_content/migration.sql',
  ),
  'utf8',
)

describe('universal ITEM migration contract', () => {
  it('adds the enum member before creating one strict typed sidecar without data rewrites', () => {
    expect(
      migration.indexOf(`ALTER TYPE "NormalizedContentModuleKind" ADD VALUE IF NOT EXISTS 'ITEM'`),
    ).toBeGreaterThanOrEqual(0)
    expect(migration.indexOf('CREATE TABLE "item_content"')).toBeGreaterThan(
      migration.indexOf(`ADD VALUE IF NOT EXISTS 'ITEM'`),
    )
    expect(migration).toContain('"kind" "NormalizedContentModuleKind" NOT NULL DEFAULT \'ITEM\'')
    expect(migration).toContain('CHECK ("kind" = \'ITEM\')')
    expect(migration).not.toMatch(/^\s*(?:INSERT INTO|UPDATE\s+|DELETE FROM)\b/im)
  })

  it('binds revision and optional Place to exact tenant and venue scope', () => {
    expect(migration).toContain('FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "kind")')
    expect(migration).toContain(
      'REFERENCES "content_module_revisions"("id", "tenant_id", "venue_id", "kind")',
    )
    expect(migration).toContain('FOREIGN KEY ("place_id", "tenant_id", "venue_id")')
    expect(migration).toContain('REFERENCES "places"("id", "tenant_id", "venue_id")')
    expect(migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)).toHaveLength(2)
  })

  it('bounds required text and makes ITEM sidecars append-only including truncate', () => {
    expect(migration).toContain('item_content_name_check')
    expect(migration).toContain('item_content_description_check')
    expect(migration).toContain('item_content_type_check')
    expect(migration).toContain('item_content_append_only')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "item_content"')
    expect(migration).toContain('item_content_no_truncate')
    expect(migration).toContain('BEFORE TRUNCATE ON "item_content"')
    expect(migration).toContain('pathfinder_reject_content_module_mutation()')
  })

  it('fails direct ITEM revision inserts closed unless the exact typed sidecar exists at commit', () => {
    expect(migration).toContain('pathfinder_require_item_content_sidecar')
    expect(migration).toContain("TG_TABLE_NAME = 'content_module_revisions' AND NEW.kind = 'ITEM'")
    expect(migration).toContain('sidecar_count IS DISTINCT FROM 1')
    expect(migration).toContain('AFTER INSERT ON "content_module_revisions"')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('SET search_path = pg_catalog')
    expect(migration).toContain('FROM public.item_content AS item')
  })
})
