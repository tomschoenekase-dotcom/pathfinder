import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const name = '20261001100000_crm_receipt_and_execution_foundations'
const sql = readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8')
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')

describe('CRM receipt and execution foundations migration contract', () => {
  it('is additive: no drops, no deletes, no rewrite of existing columns', () => {
    expect(sql).not.toMatch(/\bDROP\b/iu)
    expect(sql).not.toMatch(/\bDELETE\b/iu)
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/iu)
    expect(sql).not.toMatch(/\bTRUNCATE\b/iu)
  })

  it('adds a nullable receipt column with a unique index and nothing is required of old rows', () => {
    expect(sql).toMatch(
      /ALTER TABLE "prospect_activities" ADD COLUMN "external_receipt_key" VARCHAR\(512\);/u,
    )
    expect(sql).not.toMatch(/ADD COLUMN "external_receipt_key" VARCHAR\(512\) NOT NULL/iu)
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "prospect_activities_external_receipt_key_key"\s+ON "prospect_activities"\("external_receipt_key"\)/u,
    )
  })

  it('backfills only operator-logged sends, earliest duplicate first, so the unique index can build', () => {
    expect(sql).toMatch(/DISTINCT ON \("evidence"->>'gmailMessageId'\)/u)
    expect(sql).toMatch(/"evidence"->>'source' = 'operator-gmail'/u)
    expect(sql).toMatch(/ORDER BY "evidence"->>'gmailMessageId', "created_at", "id"/u)
    // The only table the data statement touches is the one that gains the column.
    expect(sql.match(/\bUPDATE\s+"([a-z_]+)"/gu)).toEqual(['UPDATE "prospect_activities"'])
  })

  it('matches the Prisma model', () => {
    expect(schema).toMatch(
      /externalReceiptKey\s+String\?\s+@unique\s+@map\("external_receipt_key"\)\s+@db\.VarChar\(512\)/u,
    )
  })

  it('runs in one transaction', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
  })
})
