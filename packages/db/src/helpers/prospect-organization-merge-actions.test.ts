import { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import {
  mergeProspectOrganizationsAction,
  previewProspectOrganizationMergeAction,
  PROSPECT_MERGE_DIRECT_RELATION_MODELS,
} from './prospect-organization-merge-actions'

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

describe('prospect organization merge serialization retry', () => {
  const conflict = () => Object.assign(new Error('serialization failure'), { code: 'P2034' })
  const actor = { type: 'HUMAN' as const, id: 'owner_example', role: 'PLATFORM_ADMIN' as const }
  const mergeInput = {
    sourceOrganizationId: 'source_example',
    targetOrganizationId: 'target_example',
    expectedPlanHash: 'a'.repeat(64),
    note: 'Reviewed duplicate',
    actor,
  }

  it('retries a serialization conflict and returns the next attempt', async () => {
    const receipt = { receipt: { id: 'merge_example' }, replayed: true }
    const $transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce(receipt)
    await expect(
      mergeProspectOrganizationsAction(mergeInput, { $transaction } as never),
    ).resolves.toBe(receipt)
    expect($transaction).toHaveBeenCalledTimes(3)
    expect($transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: 'Serializable' })
  })

  it('stops after a bounded number of attempts with a review-again conflict', async () => {
    const $transaction = vi.fn().mockRejectedValue(conflict())
    await expect(
      mergeProspectOrganizationsAction(mergeInput, { $transaction } as never),
    ).rejects.toMatchObject({ name: 'ProspectActionError', code: 'CONFLICT' })
    expect($transaction).toHaveBeenCalledTimes(3)
    const previewTransaction = vi.fn().mockRejectedValue(conflict())
    await expect(
      previewProspectOrganizationMergeAction(
        { sourceOrganizationId: 'source_example', targetOrganizationId: 'target_example' },
        { $transaction: previewTransaction } as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(previewTransaction).toHaveBeenCalledTimes(3)
  })

  it('never retries other failures, and refuses a non-human actor before any transaction', async () => {
    const $transaction = vi.fn().mockRejectedValue(new Error('connection lost'))
    await expect(
      mergeProspectOrganizationsAction(mergeInput, { $transaction } as never),
    ).rejects.toThrow('connection lost')
    expect($transaction).toHaveBeenCalledTimes(1)
    const untouched = vi.fn()
    await expect(
      mergeProspectOrganizationsAction(
        { ...mergeInput, actor: { ...actor, type: 'AGENT' } as never },
        { $transaction: untouched } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(untouched).not.toHaveBeenCalled()
  })
})
