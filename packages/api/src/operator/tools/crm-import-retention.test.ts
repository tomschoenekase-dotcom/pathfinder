import { describe, expect, it } from 'vitest'
import { importFieldRetention, sourceCellDigests } from './crm-import-retention'

describe('import field retention', () => {
  const text = 'Evidence '.repeat(3958)
  it('verifies a 35,623-character field without returning private text', () => {
    const provenance = text.padEnd(35_623, '.')
    expect(provenance).toHaveLength(35_623)
    const source = { Research: provenance }
    const result = importFieldRetention({
      source,
      normalized: { notes: provenance },
      mapping: { notes: 'Research' },
      manifest: { retentionDigests: [{ row: 2, fields: sourceCellDigests(source) }] },
      rowNumber: 2,
      evidence: [{ capturedValue: source }],
    })
    expect(result[0]).toMatchObject({
      sourceCharacters: 35_623,
      storedCharacters: 35_623,
      sourceRetention: 'VERIFIED',
      normalizationChanged: false,
      committedEvidenceCharacters: 35_623,
      committedEvidenceRetention: 'VERIFIED',
    })
    expect(JSON.stringify(result)).not.toContain(provenance)
  })
  it('reports staged and committed truncation, and does not invent original proof for old imports', () => {
    const source = { Research: 'full original evidence' }
    const result = importFieldRetention({
      source: { Research: 'full' },
      normalized: {},
      mapping: {},
      manifest: { retentionDigests: [{ row: 2, fields: sourceCellDigests(source) }] },
      rowNumber: 2,
      evidence: [{ capturedValue: { Research: 'ful' } }],
    })
    expect(result[0]).toMatchObject({
      sourceRetention: 'MISMATCH',
      committedEvidenceRetention: 'MISMATCH',
    })
    expect(
      importFieldRetention({
        source,
        normalized: {},
        mapping: {},
        manifest: null,
        rowNumber: 2,
        evidence: [],
      })[0],
    ).toMatchObject({
      sourceCharacters: null,
      sourceRetention: 'ORIGINAL_NOT_RECORDED',
      committedEvidenceRetention: 'NOT_AVAILABLE',
    })
  })
})
