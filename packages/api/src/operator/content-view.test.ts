import { describe, expect, it } from 'vitest'
import { flattenTyped, typedFieldsOf } from './content-view'

describe('operator fact applicability fields', () => {
  it.each([null, 'VENUE', 'SUBJECTS'])(
    'compares stored %s scope directly with the authored payload',
    (scope) => {
      const subjects = scope === 'SUBJECTS' ? ['subject-1'] : []
      const places = scope === 'SUBJECTS' ? ['place-1'] : []
      const applicability =
        scope === 'VENUE'
          ? { scope }
          : scope === 'SUBJECTS'
            ? { scope, subjectModuleIds: subjects, placeIds: places }
            : undefined
      const fields = typedFieldsOf({
        operationalFact: {
          revisionId: 'revision-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          kind: 'OPERATIONAL_FACT',
          label: 'Entry',
          value: 'North door',
          expiresAt: null,
          applicabilityScope: scope,
          applicabilitySubjectModuleIds: subjects,
          applicabilityPlaceIds: places,
        },
      })
      expect(fields).toEqual(
        flattenTyped({
          kind: 'OPERATIONAL_FACT',
          label: 'Entry',
          value: 'North door',
          expiresAt: null,
          ...(applicability ? { applicability } : {}),
        }),
      )
      expect(fields).not.toHaveProperty('applicabilityScope')
      expect(fields).not.toHaveProperty('applicabilitySubjectModuleIds')
      expect(fields).not.toHaveProperty('applicabilityPlaceIds')
      if (scope === null) expect(fields).not.toHaveProperty('applicability')
    },
  )

  it('keeps a declaration removal visible as a real change', () => {
    const before = typedFieldsOf({
      operationalFact: {
        label: 'Entry',
        value: 'North door',
        applicabilityScope: 'VENUE',
        applicabilitySubjectModuleIds: [],
        applicabilityPlaceIds: [],
      },
    })
    const after = flattenTyped({ kind: 'OPERATIONAL_FACT', label: 'Entry', value: 'North door' })
    expect(before.applicability).toBe('{"scope":"VENUE"}')
    expect(after).not.toHaveProperty('applicability')
  })
})
