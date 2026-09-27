import { describe, expect, it } from 'vitest'

import {
  classifyProspectSize,
  explainProspectSize,
  parseProspectSizeProposalFile,
  prospectCategorySizeRule,
  prospectSizeEvidenceSchema,
  prospectSizeProposalFileSchema,
} from './prospect-size'

describe('Torchiko prospect size contract', () => {
  it.each([
    [99, 'XS'],
    [100, 'S'],
    [499, 'S'],
    [500, 'M'],
    [2_999, 'M'],
    [3_000, 'L'],
    [9_999, 'L'],
    [10_000, 'XL'],
  ])('classifies %i seats as %s', (seats, expected) => {
    expect(classifyProspectSize(seats, 'seats')).toBe(expected)
  })

  it('applies explicit attendance and provisional area bands', () => {
    expect(classifyProspectSize(1_150, 'capacity')).toBe('M')
    expect(classifyProspectSize(3_500, 'capacity')).toBe('L')
    expect(classifyProspectSize(50_000, 'annual_attendance')).toBe('M')
    expect(classifyProspectSize(1_000_000, 'annual_attendance')).toBe('XL')
    expect(classifyProspectSize(10_000, 'square_feet')).toBe('M')
    expect(classifyProspectSize(200_000, 'square_feet')).toBe('XL')
    expect(classifyProspectSize(10, 'acres')).toBe('M')
    expect(classifyProspectSize(1_000, 'acres')).toBe('XL')
  })

  it('uses category rules for small museums and excludes Bears stadiums as XL', () => {
    expect(prospectCategorySizeRule('small historical society')).toBe('S')
    expect(prospectCategorySizeRule('Chicago Bears stadium')).toBe('XL')
    expect(prospectCategorySizeRule('Soldier Field')).toBeUndefined()
    expect(explainProspectSize(null)).toMatchObject({
      sizeClass: 'UNKNOWN',
      unknown: expect.any(String),
    })
    expect(
      explainProspectSize({ class: 'UNKNOWN', basis: 'unknown', observedAt: '2026-09-27' }).reason,
    ).toContain('evidence is pending')
  })

  it('requires official provenance and a date for measured evidence', () => {
    const valid = {
      class: 'M',
      basis: 'seats',
      value: 1_200,
      unit: 'seats',
      sourceUrl: 'https://venue.example/about',
      observedAt: '2026-09-27',
      confidence: 'measured',
    }
    expect(prospectSizeEvidenceSchema.safeParse(valid).success).toBe(true)
    expect(
      prospectSizeEvidenceSchema.safeParse({
        ...valid,
        basis: 'capacity',
        unit: 'people',
      }).success,
    ).toBe(true)
    expect(
      prospectSizeEvidenceSchema.safeParse({ ...valid, basis: 'capacity', unit: 'seats' }).success,
    ).toBe(false)
    expect(prospectSizeEvidenceSchema.safeParse({ ...valid, sourceUrl: undefined }).success).toBe(
      false,
    )
    expect(
      prospectSizeEvidenceSchema.safeParse({ ...valid, observedAt: '2026/09/27' }).success,
    ).toBe(false)
    expect(prospectSizeEvidenceSchema.safeParse({ ...valid, class: 'S' }).success).toBe(false)
    expect(prospectSizeEvidenceSchema.safeParse({ ...valid, unit: 'acres' }).success).toBe(false)
    expect(
      prospectSizeEvidenceSchema.safeParse({
        class: 'UNKNOWN',
        basis: 'unknown',
        observedAt: '2026-09-27',
      }).success,
    ).toBe(true)
  })

  it('parses only proposal-only files in the integration shape', () => {
    const file = {
      schema: 'torchiko.prospect-size-proposals/v1',
      status: 'proposal-only',
      records: [
        {
          venueId: 'venue-1',
          organizationId: 'org-1',
          snapshotName: 'Test Museum',
          snapshotCity: 'Chicago',
          snapshotRegion: 'IL',
          expectedUpdatedAt: null,
          size: {
            class: 'S',
            basis: 'category_rule',
            sourceUrl: 'https://venue.example/about',
            observedAt: '2026-09-27',
            confidence: 'rule',
          },
        },
        {
          venueId: 'venue-2',
          organizationId: null,
          snapshotName: 'Venue awaiting identity match',
          snapshotCity: null,
          snapshotRegion: null,
          expectedUpdatedAt: null,
          size: { class: 'UNKNOWN', basis: 'unknown', observedAt: '2026-09-27' },
        },
      ],
    }
    expect(parseProspectSizeProposalFile(file)).toEqual(file)
    expect(
      prospectSizeProposalFileSchema.safeParse({
        ...file,
        records: [
          {
            ...file.records[0],
            size: {
              class: 'S',
              basis: 'category_rule',
              observedAt: '2026-09-27',
              confidence: 'rule',
            },
          },
        ],
      }).success,
    ).toBe(false)
    expect(prospectSizeProposalFileSchema.safeParse({ ...file, status: 'applied' }).success).toBe(
      false,
    )
    expect(
      prospectSizeProposalFileSchema.safeParse({
        ...file,
        records: [file.records[0], file.records[0]],
      }).success,
    ).toBe(false)
  })
})
