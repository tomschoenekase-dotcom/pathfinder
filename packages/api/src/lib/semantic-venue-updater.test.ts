import { describe, expect, it } from 'vitest'

import { buildSemanticVenueUpdate, type SemanticUpdaterInput } from './semantic-venue-updater'

const current = {
  id: 'cm12345678901234567890123',
  title: 'Museum hours',
  category: 'HOURS',
  content: 'Open 10–5 daily.',
  isEnabled: true,
  authority: 'OFFICIAL_VENUE_SOURCE' as const,
}
const changedHours = {
  title: current.title,
  category: current.category,
  content: 'Open 9–5 daily.',
  isEnabled: current.isEnabled,
}

const base: SemanticUpdaterInput = {
  venueId: 'venue-a',
  relation: 'NEW_FACT',
  desired: {
    title: 'Parking',
    category: 'ARRIVAL',
    content: 'Use the north lot.',
    isEnabled: true,
  },
  contentOrigin: 'HUMAN_AUTHORED',
  evidenceReview: 'HUMAN_REVIEWED',
  evidence: [
    {
      id: 'evidence-a',
      authority: 'VENUE_CONFIRMED',
      confidence: 0.96,
      normalizedHash: 'a'.repeat(64),
      retrievedAt: '2026-08-25T12:00:00.000Z',
      sourceName: 'Venue operator',
    },
  ],
}

describe('semantic venue updater', () => {
  it('builds one additive package operation for a new fact', () => {
    const result = buildSemanticVenueUpdate(base, [current])
    expect(result).toMatchObject({ classification: 'ADDITION', operationCount: 1 })
    expect(result.venuePackagePatch?.knowledgeEntries.create).toHaveLength(1)
    expect(result.venuePackagePatch?.knowledgeEntries.update).toHaveLength(0)
  })

  it('recognizes a semantic duplicate without creating a package', () => {
    const result = buildSemanticVenueUpdate(
      {
        ...base,
        desired: {
          title: ' Museum HOURS ',
          category: 'hours',
          content: 'Open   10–5 daily.',
          isEnabled: true,
        },
      },
      [current],
    )
    expect(result).toMatchObject({
      classification: 'DUPLICATE_NOOP',
      operationCount: 0,
      requiresHumanReview: false,
      venuePackagePatch: null,
    })
  })

  it.each([
    ['CORRECTS', 'CORRECTION'],
    ['SUPERSEDES', 'SUPERSESSION'],
  ] as const)('creates one targeted update for %s', (relation, classification) => {
    const result = buildSemanticVenueUpdate(
      {
        ...base,
        relation,
        targetKnowledgeEntryId: current.id,
        desired: changedHours,
      },
      [current],
    )
    expect(result).toMatchObject({ classification, operationCount: 1 })
    expect(result.venuePackagePatch?.knowledgeEntries.update).toEqual([
      expect.objectContaining({
        id: current.id,
        value: expect.objectContaining({ content: 'Open 9–5 daily.' }),
      }),
    ])
    expect(result.venuePackagePatch?.knowledgeEntries.delete).toHaveLength(0)
  })

  it('routes bounded temporal truth to a draft operational update', () => {
    const result = buildSemanticVenueUpdate(
      {
        ...base,
        desired: { ...base.desired, title: 'Holiday hours', content: 'Open noon–4.' },
        validFrom: '2026-12-24T12:00:00.000Z',
        validUntil: '2026-12-24T22:00:00.000Z',
        operationalUpdateType: 'CHANGED_HOURS',
      },
      [current],
    )
    expect(result).toMatchObject({
      classification: 'TEMPORAL',
      operationCount: 1,
      venuePackagePatch: null,
      operationalUpdateDraft: {
        updateType: 'CHANGED_HOURS',
        status: 'DRAFT',
        autoSchedule: false,
        autoPublish: false,
      },
    })
  })

  it('turns ambiguous same-key evidence into a durable-ready question', () => {
    const result = buildSemanticVenueUpdate(
      {
        ...base,
        desired: changedHours,
      },
      [current],
    )
    expect(result).toMatchObject({
      classification: 'CONFLICT',
      operationCount: 0,
      blockers: [expect.objectContaining({ code: 'TARGET_REQUIRED' })],
      questions: [expect.objectContaining({ owner: 'VENUE_OPERATOR' })],
    })
  })

  it('does not let lower-authority evidence replace a stronger fact', () => {
    const result = buildSemanticVenueUpdate(
      {
        ...base,
        relation: 'CORRECTS',
        targetKnowledgeEntryId: current.id,
        desired: changedHours,
        evidence: [{ ...base.evidence[0]!, authority: 'PUBLIC_SECONDARY' }],
      },
      [current],
    )
    expect(result).toMatchObject({
      classification: 'CONFLICT',
      blockers: [expect.objectContaining({ code: 'LOWER_AUTHORITY_CONFLICT' })],
      venuePackagePatch: null,
    })
  })

  it('rejects incomplete or inverted temporal windows', () => {
    expect(() =>
      buildSemanticVenueUpdate({ ...base, validFrom: '2026-12-24T12:00:00.000Z' }, []),
    ).toThrow()
    expect(() =>
      buildSemanticVenueUpdate(
        {
          ...base,
          validFrom: '2026-12-25T12:00:00.000Z',
          validUntil: '2026-12-24T12:00:00.000Z',
        },
        [],
      ),
    ).toThrow()
  })
})
