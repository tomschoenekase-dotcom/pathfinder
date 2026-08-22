import { describe, expect, it } from 'vitest'

import { parseProspectStagingPackage } from './prospect-staging-package'

function validPackage() {
  return {
    schema: 'torchiko.prospect-staging-package/v1',
    packageId: 'package-1',
    sourceSystem: 'HERMES_STAGING',
    createdAt: '2026-08-22T15:00:00.000Z',
    sourceWorkbook: { name: 'source.xlsx', sha256: 'a'.repeat(64), rowCount: 1 },
    lineage: { runId: 'run-1', promptVersion: 'prompt-v1', models: ['model-1'] },
    counts: {
      PROSPECT: 1,
      CONTACT: 0,
      EVIDENCE: 1,
      DRAFT: 1,
      DUPLICATE_REVIEW: 0,
      EXCEPTION: 0,
      RUN_LOG: 0,
    },
    records: [
      {
        kind: 'PROSPECT',
        externalId: 'prospect-1',
        raw: { Name: 'Museum' },
        normalized: { name: 'Museum' },
        status: 'RESEARCHED',
      },
      {
        kind: 'EVIDENCE',
        externalId: 'evidence-1',
        parentExternalId: 'prospect-1',
        raw: { url: 'https://example.org' },
        normalized: {},
        status: 'CURRENT',
      },
      {
        kind: 'DRAFT',
        externalId: 'draft-1',
        parentExternalId: 'prospect-1',
        raw: { subject: 'Hello', body: 'Grounded body' },
        normalized: {},
        status: 'DRAFT',
        draftVersion: 1,
        supportingEvidenceIds: ['evidence-1'],
        humanReviewStatus: 'NOT_REVIEWED',
        sendAuthority: 'NONE',
      },
    ],
  }
}

describe('prospect staging package v1', () => {
  it('parses and hashes a complete inert package deterministically', () => {
    const first = parseProspectStagingPackage(validPackage())
    const second = parseProspectStagingPackage(validPackage())
    expect(first.packageHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(second.packageHash).toBe(first.packageHash)
  })

  it('rejects duplicate stable identities and count drift', () => {
    const value = validPackage()
    value.records.push({ ...value.records[0]! })
    expect(() => parseProspectStagingPackage(value)).toThrow(/Duplicate staging identity|count/u)
  })

  it('rejects drafts that gain review or send authority', () => {
    const value = validPackage()
    Object.assign(value.records[2]!, { humanReviewStatus: 'APPROVED', sendAuthority: 'SEND' })
    expect(() => parseProspectStagingPackage(value)).toThrow()
  })

  it('rejects draft evidence references absent from the same package', () => {
    const value = validPackage()
    Object.assign(value.records[2]!, { supportingEvidenceIds: ['missing'] })
    expect(() => parseProspectStagingPackage(value)).toThrow(/missing evidence/u)
  })

  it('validates a deterministic 20,000-prospect admission manifest', () => {
    const value = validPackage() as unknown as {
      sourceWorkbook: { rowCount: number }
      counts: Record<string, number>
      records: unknown[]
    }
    value.sourceWorkbook.rowCount = 20_000
    value.counts.PROSPECT = 20_000
    value.counts.EVIDENCE = 0
    value.counts.DRAFT = 0
    value.records = Array.from({ length: 20_000 }, (_, index) => ({
      kind: 'PROSPECT',
      externalId: `prospect-${index.toString().padStart(5, '0')}`,
      raw: { sourceRow: index + 2 },
      normalized: { name: `Synthetic Venue ${index}` },
      status: 'NOT_STARTED',
    }))
    const started = performance.now()
    const result = parseProspectStagingPackage(value)
    expect(result.package.records).toHaveLength(20_000)
    expect(performance.now() - started).toBeLessThan(5_000)
  }, 10_000)
})
