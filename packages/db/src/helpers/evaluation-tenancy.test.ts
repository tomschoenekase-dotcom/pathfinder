import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import { TENANTED_TABLES } from '../tenanted-tables'

describe('evaluation persistence tenant registry', () => {
  it('classifies every generated evaluation model as tenant-owned', () => {
    const modelNames = [
      'EvalCase',
      'EvalRun',
      'EvalRunCostReservation',
      'EvalResult',
      'EvalReview',
    ] as const
    for (const modelName of modelNames) {
      expect(TENANTED_TABLES).toContain(modelName)
      const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName)
      expect(model?.fields.find((field) => field.name === 'tenantId')).toMatchObject({
        isRequired: true,
        type: 'String',
      })
      expect(model?.fields.find((field) => field.name === 'venueId')).toMatchObject({
        isRequired: true,
        type: 'String',
      })
    }
  })

  it('generates composite ownership relations for cases, runs, and results', () => {
    for (const modelName of [
      'EvalCase',
      'EvalRun',
      'EvalRunCostReservation',
      'EvalResult',
      'EvalReview',
    ]) {
      const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName)
      const venueRelation = model?.fields.find((field) => field.name === 'venue')
      expect(venueRelation?.relationFromFields).toEqual(['venueId', 'tenantId'])
    }
    const result = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === 'EvalResult')
    expect(result?.fields.find((field) => field.name === 'run')?.relationFromFields).toEqual([
      'runId',
      'runIdentityHash',
      'tenantId',
      'venueId',
    ])
    expect(result?.fields.find((field) => field.name === 'evalCase')?.relationFromFields).toEqual([
      'caseId',
      'caseRevision',
      'caseHash',
      'tenantId',
      'venueId',
    ])
    const review = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === 'EvalReview')
    expect(review?.fields.find((field) => field.name === 'result')?.relationFromFields).toEqual([
      'resultId',
      'tenantId',
      'venueId',
    ])
  })
})
