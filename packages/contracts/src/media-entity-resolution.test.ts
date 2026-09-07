import { describe, expect, it } from 'vitest'

import {
  assessMediaEntityMatch,
  createMediaEvidenceLocatorIndex,
  MediaEntityMergeProposalSchema,
  mediaEvidenceLocatorId,
  validateMediaRelationEvidence,
  validateMediaRelationAuthority,
  validateMediaMergeAuthority,
  type MediaEntityCandidate,
} from './media-entity-resolution'

const locator = (sourceId: string, observationIndex = 0) => ({
  tenantId: 'tenant-a',
  projectId: 'project-a',
  uploadAttemptId: '11111111-1111-4111-8111-111111111111',
  sourceId,
  sourceSha256: 'a'.repeat(64),
  observationIndex,
  observationSha256: 'b'.repeat(64),
})

const candidate = (override: Partial<MediaEntityCandidate> = {}): MediaEntityCandidate => ({
  candidateId: 'candidate-a',
  label: 'North Greenhouse',
  kind: 'room',
  evidence: [locator('image-a')],
  identifiers: [],
  contextKeys: [],
  ...override,
})

describe('media entity resolution contracts', () => {
  it('retains exact source evidence through an authorized merge reversal', () => {
    const a = candidate()
    const b = candidate({ candidateId: 'candidate-b', evidence: [locator('image-b')] })
    const sourceIdentities = [a, b].map((item) => ({
      candidateId: item.candidateId,
      evidenceLocatorIds: item.evidence.map(mediaEvidenceLocatorId),
    }))
    const proposal = {
      proposalId: 'merge-a',
      candidateIds: [a.candidateId, b.candidateId],
      sourceIdentities,
      evidenceLocatorIds: sourceIdentities.flatMap((item) => item.evidenceLocatorIds),
      status: 'REVERTED' as const,
      canonicalEntityId: 'canonical-a',
      revision: 2,
    }
    const authority = {
      scope: {
        tenantId: 'tenant-a',
        projectId: 'project-a',
        uploadAttemptId: locator('a').uploadAttemptId,
      },
      availableLocatorIds: new Set(proposal.evidenceLocatorIds),
      canonicalEntityIds: new Set(['canonical-a']),
    }
    expect(validateMediaMergeAuthority(proposal, [a, b], authority)).toEqual(proposal)
    expect(() =>
      validateMediaMergeAuthority({ ...proposal, canonicalEntityId: 'foreign' }, [a, b], authority),
    ).toThrow('venue authority')
    expect(() =>
      validateMediaMergeAuthority(
        {
          ...proposal,
          sourceIdentities: [
            sourceIdentities[0]!,
            {
              candidateId: b.candidateId,
              evidenceLocatorIds: sourceIdentities[0]!.evidenceLocatorIds,
            },
          ],
        },
        [a, b],
        authority,
      ),
    ).toThrow('exact available candidate evidence')
    expect(() =>
      validateMediaMergeAuthority(
        { ...proposal, evidenceLocatorIds: [proposal.evidenceLocatorIds[0]!] },
        [a, b],
        authority,
      ),
    ).toThrow('must equal')
  })
  it('never proposes a merge across two individually valid but different evidence scopes', () => {
    const left = candidate({ identifiers: [{ scheme: 'inventory_id', value: 'GH-12' }] })
    for (const scope of [
      { tenantId: 'tenant-b' },
      { projectId: 'project-b' },
      { uploadAttemptId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      const right = candidate({
        candidateId: 'candidate-b',
        identifiers: left.identifiers,
        evidence: [{ ...locator('image-b'), ...scope }],
      })
      expect(assessMediaEntityMatch(left, right).disposition).toBe('KEEP_DISTINCT')
    }
  })

  it('rejects conflicting repeated identifiers instead of hiding one in a map', () => {
    expect(() =>
      assessMediaEntityMatch(
        candidate({
          identifiers: [
            { scheme: 'inventory_id', value: 'GH-12' },
            { scheme: 'inventory_id', value: 'GH-13' },
          ],
        }),
        candidate({ candidateId: 'candidate-b' }),
      ),
    ).toThrow('identifier schemes')
  })

  it('keeps long Unicode and delimiter-bearing source identities portable within the locator bound', () => {
    const value = {
      ...locator('界'.repeat(500)),
      tenantId: '界'.repeat(191),
      projectId: '界'.repeat(191),
    }
    expect(mediaEvidenceLocatorId(value).length).toBeLessThanOrEqual(2500)
    expect(mediaEvidenceLocatorId(locator('a:b'))).not.toBe(
      mediaEvidenceLocatorId({ ...locator('b'), projectId: 'project-a:a' }),
    )
  })
  it('never merges matching labels without identity evidence', () => {
    expect(
      assessMediaEntityMatch(
        candidate(),
        candidate({ candidateId: 'candidate-b', evidence: [locator('image-b')] }),
      ),
    ).toEqual({
      disposition: 'KEEP_DISTINCT',
      reasons: ['A matching label alone is not identity evidence.'],
    })
  })

  it('proposes an identifier match while retaining contextual matches as review hypotheses', () => {
    expect(
      assessMediaEntityMatch(
        candidate({ identifiers: [{ scheme: 'inventory_id', value: 'GH-12' }] }),
        candidate({
          candidateId: 'candidate-b',
          identifiers: [{ scheme: 'inventory_id', value: 'GH-12' }],
        }),
      ).disposition,
    ).toBe('PROPOSE_MERGE')
    expect(
      assessMediaEntityMatch(
        candidate({ contextKeys: ['floor:1', 'zone:north'] }),
        candidate({
          candidateId: 'candidate-b',
          evidence: [locator('image-b')],
          contextKeys: ['floor:1', 'zone:north'],
        }),
      ).disposition,
    ).toBe('REVIEW_HYPOTHESIS')
  })

  it('keeps conflicting durable identifiers distinct and does not count duplicate context keys', () => {
    expect(
      assessMediaEntityMatch(
        candidate({ identifiers: [{ scheme: 'inventory_id', value: 'GH-12' }] }),
        candidate({
          candidateId: 'candidate-b',
          identifiers: [{ scheme: 'inventory_id', value: 'GH-13' }],
        }),
      ),
    ).toMatchObject({ disposition: 'KEEP_DISTINCT' })
    expect(
      assessMediaEntityMatch(
        candidate({ contextKeys: ['floor:1', 'floor:1'] }),
        candidate({
          candidateId: 'candidate-b',
          evidence: [locator('image-b')],
          contextKeys: ['floor:1'],
        }),
      ),
    ).toMatchObject({ disposition: 'KEEP_DISTINCT' })
  })

  it('requires exact available locators and refuses visual adjacency as traversability', () => {
    const evidenceId = mediaEvidenceLocatorId(locator('map-a'))
    const base = {
      proposalId: 'relation-1',
      fromCandidateId: 'a',
      toCandidateId: 'b',
      kind: 'TRAVERSABLE' as const,
      evidenceLocatorIds: [evidenceId],
      confidence: 'probable' as const,
      reviewStatus: 'PENDING' as const,
    }
    expect(() =>
      validateMediaRelationEvidence({ ...base, basis: 'visual_overlap' }, new Set([evidenceId])),
    ).toThrow('Traversability')
    expect(() =>
      validateMediaRelationEvidence({ ...base, basis: 'explicit_path' }, new Set()),
    ).toThrow('unavailable')
  })

  it('refuses cross-tenant, project, or upload-generation evidence and hash tampering', () => {
    const authoritative = locator('image-a')
    const scope = {
      tenantId: authoritative.tenantId,
      projectId: authoritative.projectId,
      uploadAttemptId: authoritative.uploadAttemptId,
    }
    const index = createMediaEvidenceLocatorIndex(scope, [authoritative])
    for (const changed of [
      { ...authoritative, tenantId: 'tenant-b' },
      { ...authoritative, projectId: 'project-b' },
      { ...authoritative, uploadAttemptId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      expect(() => createMediaEvidenceLocatorIndex(scope, [changed])).toThrow(
        'different tenant, project, or upload generation',
      )
    }
    expect(
      index.has(mediaEvidenceLocatorId({ ...authoritative, sourceSha256: 'c'.repeat(64) })),
    ).toBe(false)
    expect(
      index.has(mediaEvidenceLocatorId({ ...authoritative, observationSha256: 'd'.repeat(64) })),
    ).toBe(false)
    expect(() =>
      assessMediaEntityMatch(
        candidate({
          evidence: [authoritative, { ...locator('image-b'), tenantId: 'tenant-b' }],
        }),
        candidate({ candidateId: 'candidate-b', evidence: [locator('image-c')] }),
      ),
    ).toThrow('cannot mix evidence scopes')
  })

  it('requires reviewed canonical endpoints before a relation can be accepted', () => {
    const evidenceId = mediaEvidenceLocatorId(locator('map-a'))
    expect(() =>
      validateMediaRelationEvidence(
        {
          proposalId: 'relation-1',
          fromCandidateId: 'a',
          toCandidateId: 'b',
          kind: 'ADJACENT',
          evidenceLocatorIds: [evidenceId],
          basis: 'visual_overlap',
          confidence: 'confirmed',
          reviewStatus: 'ACCEPTED',
        },
        new Set([evidenceId]),
      ),
    ).toThrow('canonical location endpoints')
  })

  it('requires candidate and canonical relation endpoints from reviewed authority', () => {
    const evidenceId = mediaEvidenceLocatorId(locator('map-a'))
    const proposal = {
      proposalId: 'relation-1',
      fromCandidateId: 'candidate-a',
      toCandidateId: 'candidate-b',
      kind: 'ADJACENT' as const,
      evidenceLocatorIds: [evidenceId],
      basis: 'visual_overlap' as const,
      confidence: 'confirmed' as const,
      reviewStatus: 'ACCEPTED' as const,
      canonicalFromLocationId: '11111111-1111-4111-8111-111111111111',
      canonicalToLocationId: '22222222-2222-4222-8222-222222222222',
    }
    expect(() =>
      validateMediaRelationAuthority(proposal, {
        availableLocatorIds: new Set([evidenceId]),
        candidateIds: new Set(['candidate-a']),
        canonicalLocationIds: new Set([
          proposal.canonicalFromLocationId,
          proposal.canonicalToLocationId,
        ]),
      }),
    ).toThrow('outside the reviewed media project')
    expect(() =>
      validateMediaRelationAuthority(proposal, {
        availableLocatorIds: new Set([evidenceId]),
        candidateIds: new Set(['candidate-a', 'candidate-b']),
        canonicalLocationIds: new Set([proposal.canonicalFromLocationId]),
      }),
    ).toThrow('outside the reviewed venue authority')
  })

  it('retains source candidates and canonical identity for reversible reviewed merges', () => {
    expect(() =>
      MediaEntityMergeProposalSchema.parse({
        proposalId: 'merge-1',
        candidateIds: ['candidate-a', 'candidate-b'],
        evidenceLocatorIds: [mediaEvidenceLocatorId(locator('image-a'))],
        sourceIdentities: [
          { candidateId: 'candidate-a', evidenceLocatorIds: ['evidence-a'] },
          { candidateId: 'candidate-b', evidenceLocatorIds: ['evidence-b'] },
        ],
        status: 'REVERTED',
        revision: 2,
      }),
    ).toThrow('retain the canonical entity ID')
    expect(
      MediaEntityMergeProposalSchema.parse({
        proposalId: 'merge-1',
        candidateIds: ['candidate-a', 'candidate-b'],
        evidenceLocatorIds: [mediaEvidenceLocatorId(locator('image-a'))],
        sourceIdentities: [
          { candidateId: 'candidate-a', evidenceLocatorIds: ['evidence-a'] },
          { candidateId: 'candidate-b', evidenceLocatorIds: ['evidence-b'] },
        ],
        status: 'REVERTED',
        canonicalEntityId: 'location-1',
        revision: 2,
      }),
    ).toMatchObject({ status: 'REVERTED', candidateIds: ['candidate-a', 'candidate-b'] })
    expect(() =>
      MediaEntityMergeProposalSchema.parse({
        proposalId: 'merge-2',
        candidateIds: ['candidate-a', 'candidate-b'],
        evidenceLocatorIds: ['evidence-a'],
        sourceIdentities: [
          { candidateId: 'candidate-a', evidenceLocatorIds: ['evidence-a'] },
          { candidateId: 'candidate-a', evidenceLocatorIds: ['evidence-b'] },
        ],
        status: 'REVERTED',
        canonicalEntityId: 'location-1',
        revision: 3,
      }),
    ).toThrow('preserve every candidate exactly once')
  })
})
