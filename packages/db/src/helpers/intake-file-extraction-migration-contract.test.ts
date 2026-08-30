import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260829032000_add_intake_file_extraction_receipts/migration.sql',
  import.meta.url,
)
const pdfMigration = new URL(
  '../../prisma/migrations/20260829231500_enable_pdf_file_extraction/migration.sql',
  import.meta.url,
)

describe('intake file extraction receipt migration contract', () => {
  it('adds bounded text formats and exact tenant/run/upload terminal evidence', async () => {
    const sql = await readFile(migration, 'utf8')
    for (const mime of ['application/json', 'text/plain', 'text/markdown', 'text/csv']) {
      expect(sql).toContain(`'${mime}'`)
    }
    expect(sql).toContain('intake_file_extraction_receipts_terminal_shape_check')
    expect(sql).toContain('source_byte_size" BETWEEN 1 AND 2097152')
    expect(sql).toContain('intake_file_extraction_receipts_run_scope_fkey')
    expect(sql).toContain('intake_file_extraction_receipts_upload_scope_fkey')
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT')
  })

  it('makes receipts append-only through row mutation and truncate boundaries', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain("RAISE EXCEPTION '% is append-only'")
  })

  it('contains no package, approval, apply, publication, or provider dispatch surface', async () => {
    const sql = `${await readFile(migration, 'utf8')}\n${await readFile(pdfMigration, 'utf8')}`
    expect(sql).not.toMatch(/package_draft|approval_grant|publish(ed|ing)?|provider_dispatch/iu)
  })

  it('adds only a bounded PDF adapter while retaining the text-document boundary', async () => {
    const sql = await readFile(pdfMigration, 'utf8')
    expect(sql).toContain('source_byte_size" BETWEEN 1 AND 10485760')
    expect(sql).toContain("'application/pdf'")
    expect(sql).toContain("extractor\" = 'pathfinder-pdfjs-document'")
    expect(sql).toContain('source_byte_size" <= 2097152')
    expect(sql).toContain("extractor\" = 'pathfinder-utf8-document'")
  })
})
