import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260812001300_add_external_credential_operations/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('external credential lifecycle migration', () => {
  it('adds immutable UUID/hash operation receipts without fabricating history', () => {
    expect(sql).toContain('"operation_id" UUID NOT NULL')
    expect(sql).toContain('"operation_hash" CHAR(64) NOT NULL')
    expect(sql).toContain('external credential operation receipt is append-only')
    expect(sql).not.toMatch(/INSERT INTO "external_credential_operation_receipts"\s+SELECT/u)
  })

  it('keeps credentials disabled and identity, expiry, use, and revocation immutable', () => {
    expect(sql).toContain('external credential enablement is unavailable')
    expect(sql).toContain('external credential identity is immutable')
    expect(sql).toContain('external credential use tracking is unavailable')
    expect(sql).toContain('only an exact terminal external credential revocation update is allowed')
    expect(sql).toContain('external credential revocation requires exact timestamp evidence')
  })

  it('preflights rotation forks and enforces exact operation lineage and canonical capabilities', () => {
    expect(sql).toContain('historical external credential has multiple outgoing rotations')
    expect(sql).toContain('external_rotations_previous_once_key')
    expect(sql).toContain('external_credential_operations_single_origin_key')
    expect(sql).toContain("WHERE \"operation_kind\" IN ('ISSUE', 'ROTATE')")
    expect(sql).toContain('rotate receipt requires exact lineage')
    expect(sql).toContain('unsupported MCP credential capability')
    expect(sql).toContain('unsupported partner credential capability')
    expect(sql).toContain('external credential capabilities must be sorted and unique')
    expect(sql).toContain("IF TG_OP = 'INSERT' AND NOT EXISTS")
    expect(sql).toContain('external_credential_rotations_insert_guard')
    expect(sql).toContain('external_credential_revocations_insert_guard')
    expect(sql).toContain('previous_record."venue_id" IS DISTINCT FROM NEW."venue_id"')
    expect(sql).toContain('previous_record."revoked_at" IS DISTINCT FROM NEW."rotated_at"')
    expect(sql).toContain('previous_record."label" IS DISTINCT FROM new_record."label"')
    expect(sql).toContain('previous_record."expires_at" IS DISTINCT FROM new_record."expires_at"')
    expect(sql).toContain('new_record."created_by" IS DISTINCT FROM NEW."rotated_by"')
    expect(sql).toContain('new_record."created_at" IS DISTINCT FROM NEW."rotated_at"')
    expect(sql).toContain('external credential rotation requires exact operation evidence')
    expect(sql).toContain('rotated credential revocation requires exact operation evidence')
    expect(sql).toContain('external credential revocation requires exact operation evidence')
    expect(sql).toContain('r."reason_code" <> \'ROTATED\'')
    expect(sql).toContain('receipt."previous_credential_id" = NEW."previous_credential_id"')
  })

  it('does not demand fabricated origin receipts when legacy credentials are safely revoked', () => {
    const originGuard = sql.match(
      /IF TG_OP = 'INSERT' AND NOT EXISTS \(SELECT 1 FROM "external_credential_operation_receipts"[\s\S]*?END IF;/u,
    )
    expect(originGuard?.[0]).toContain('new external credential requires operation evidence')
    expect(sql).not.toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM "external_credential_operation_receipts" receipt WHERE receipt\."credential_id" = NEW\."id" AND receipt\."operation_kind" IN \('ISSUE','ROTATE'\)\)/u,
    )
  })
})
