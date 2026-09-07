import { describe, expect, it } from 'vitest'
import { deriveResolutionCandidates, validateResolutionEvidence } from './media-resolution-evidence'
import { mediaIntakeHash } from './media-intake-snapshot'

const scope = {
  tenantId: 'tenant-a',
  projectId: 'project-a',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
}
const observation = {
  kind: 'entity_candidate',
  statement: 'A labeled greenhouse.',
  evidenceChannel: 'visual',
  directness: 'inferred',
  confidence: 'probable',
  startSeconds: 4,
  endSeconds: 8,
}
function fixture() {
  return {
    scope,
    sourceGeneration: '22222222-2222-4222-8222-222222222222',
    candidates: [
      {
        candidateId: 'greenhouse',
        label: 'Greenhouse',
        kind: 'building',
        identifiers: [],
        contextKeys: [],
        evidence: [
          {
            ...scope,
            sourceId: 'tour.mp4',
            sourceSha256: 'a'.repeat(64),
            observationIndex: 0,
            observationSha256: mediaIntakeHash(observation),
          },
        ],
      },
    ],
    findings: [
      {
        sourceId: 'tour.mp4',
        filename: 'tour.mp4',
        mediaType: 'VIDEO',
        summary: 'A greenhouse is visible.',
        uncertainties: ['Its exact identity is unconfirmed.'],
        observations: [observation],
      },
    ],
    assets: [{ sourceId: 'tour.mp4', sha256: 'a'.repeat(64), status: 'COMPLETE' }],
  }
}
describe('frozen resolution source evidence', () => {
  it('keeps repeated labels as separate stable mentions and skips failed sources', () => {
    const input = fixture()
    input.findings[0]!.observations.push({ ...observation })
    const first = deriveResolutionCandidates(input)
    expect(first.candidates).toHaveLength(2)
    expect(first.candidates[0]!.candidateId).not.toBe(first.candidates[1]!.candidateId)
    expect(first.candidates[0]!.label).toBe(first.candidates[1]!.label)
    expect(first).toEqual(deriveResolutionCandidates(input))
    expect(first.candidates.every((candidate) => candidate.identifiers.length === 0)).toBe(true)
    input.assets[0]!.status = 'FAILED'
    expect(deriveResolutionCandidates(input).candidates).toEqual([])
  })
  it('reports a bounded incomplete preview instead of silently merging or claiming all mentions', () => {
    const input = fixture()
    input.findings[0]!.observations = Array.from({ length: 501 }, () => ({ ...observation }))
    const result = deriveResolutionCandidates(input)
    expect(result.candidates).toHaveLength(500)
    expect(result.truncated).toBe(true)
  })
  it('retains the actual observation and uncertainty-bearing fields behind its locator', () => {
    const result = validateResolutionEvidence(fixture())
    expect(result.evidenceSnapshot.evidence[0]?.observation).toEqual(observation)
    expect(result.evidenceSnapshot.sources[0]?.uncertainties).toEqual([
      'Its exact identity is unconfirmed.',
    ])
    expect(result.evidenceSnapshotHash).toBe(mediaIntakeHash(result.evidenceSnapshot))
  })
  it('rejects a wrong tenant, changed source and changed observation', () => {
    const wrongTenant = fixture()
    wrongTenant.candidates[0]!.evidence[0]!.tenantId = 'other'
    expect(() => validateResolutionEvidence(wrongTenant)).toThrow(/scope/)
    const changedSource = fixture()
    changedSource.assets[0]!.sha256 = 'b'.repeat(64)
    expect(() => validateResolutionEvidence(changedSource)).toThrow(/changed/)
    const changedObservation = fixture()
    changedObservation.findings[0]!.observations = [
      { ...observation, statement: 'Something different.' },
    ]
    expect(() => validateResolutionEvidence(changedObservation)).toThrow(/observation/)
  })
  it('rejects failed or missing source processing and out-of-range locators', () => {
    const failed = fixture()
    failed.assets[0]!.status = 'FAILED'
    expect(() => validateResolutionEvidence(failed)).toThrow(/incomplete/)
    const missing = fixture()
    missing.assets = []
    expect(() => validateResolutionEvidence(missing)).toThrow(/unavailable/)
    const outside = fixture()
    outside.candidates[0]!.evidence[0]!.observationIndex = 1
    expect(() => validateResolutionEvidence(outside)).toThrow(/observation/)
  })
  it('rejects ambiguous duplicate source rows', () => {
    const duplicate = fixture()
    duplicate.findings.push(duplicate.findings[0]!)
    expect(() => validateResolutionEvidence(duplicate)).toThrow(/ambiguous/)
  })
  it('changes the evidence receipt when reviewed candidate identity metadata changes', () => {
    const before = fixture(),
      after = fixture()
    after.candidates[0]!.label = 'Other greenhouse'
    expect(validateResolutionEvidence(before).evidenceSnapshotHash).not.toBe(
      validateResolutionEvidence(after).evidenceSnapshotHash,
    )
  })
})
