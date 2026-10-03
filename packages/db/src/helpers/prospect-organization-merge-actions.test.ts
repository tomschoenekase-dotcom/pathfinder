import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'

import { PROSPECT_MERGE_DIRECT_RELATION_MODELS } from './prospect-organization-merge-actions'

describe('prospect organization merge relation inventory', () => {
  it('accounts for every direct organization foreign key when the schema grows', () => {
    const relationModels = Prisma.dmmf.datamodel.models
      .filter(
        (model) =>
          model.name !== 'ProspectOrganization' &&
          model.name !== 'ProspectOrganizationMerge' &&
          model.fields.some(
            (field) =>
              field.kind === 'object' &&
              field.type === 'ProspectOrganization' &&
              (field.relationFromFields?.length ?? 0) > 0,
          ),
      )
      .map((model) => `${model.name[0]!.toLowerCase()}${model.name.slice(1)}`)
      .sort()
    expect([...PROSPECT_MERGE_DIRECT_RELATION_MODELS].sort()).toEqual(relationModels)
  })
})
