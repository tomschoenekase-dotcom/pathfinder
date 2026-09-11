import { describe, expect, it, vi } from 'vitest'

import {
  finalizeIntakeV1PackageHandoffInTransaction,
  readIntakeV1PackageHandoff,
} from './intake-v1-package-handoff'

const value = {
  tenantId: 'tenant',
  venueId: 'venue',
  revisionId: 'revision',
  packageDraftId: 'package',
  operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  manifestHash: 'a'.repeat(64),
  candidateHash: 'b'.repeat(64),
  payloadHash: 'b'.repeat(64),
  selectedMemberIds: ['member'],
  partialAcknowledged: false,
  createdBy: 'admin',
}

describe('V1 package handoff', () => {
  it('rejects duplicate or oversized selections before writes', async () => {
    const tx = { intakeV1PackageHandoff: { findFirst: vi.fn(), create: vi.fn() } }
    await expect(
      finalizeIntakeV1PackageHandoffInTransaction(tx as never, {
        ...value,
        selectedMemberIds: ['member', 'member'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      finalizeIntakeV1PackageHandoffInTransaction(tx as never, {
        ...value,
        selectedMemberIds: Array.from({ length: 51 }, (_, index) => `member-${index}`),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.intakeV1PackageHandoff.findFirst).not.toHaveBeenCalled()
  })

  it('returns an exact historical replay even after package lifecycle advances', async () => {
    const existing = {
      ...value,
      selectedMemberIds: ['member'],
      packageDraft: { id: 'package', status: 'APPLIED' },
    }
    const tx = {
      intakeV1PackageHandoff: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn() },
    }
    await expect(finalizeIntakeV1PackageHandoffInTransaction(tx as never, value)).resolves.toEqual({
      handoff: existing,
      replayed: true,
    })
    expect(tx.intakeV1PackageHandoff.create).not.toHaveBeenCalled()
  })

  it('rejects a reused operation with mismatched identity fields', async () => {
    const existing = { ...value, selectedMemberIds: ['member'], packageDraft: null }
    const tx = {
      intakeV1PackageHandoff: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn() },
    }
    await expect(
      finalizeIntakeV1PackageHandoffInTransaction(tx as never, {
        ...value,
        candidateHash: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.intakeV1PackageHandoff.create).not.toHaveBeenCalled()
  })

  it('rejects a create result whose exact readback no longer matches', async () => {
    const tx = {
      intakeV1PackageHandoff: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ ...value, id: 'handoff', candidateHash: 'c'.repeat(64) }),
        create: vi.fn().mockResolvedValue({ id: 'handoff' }),
      },
    }
    await expect(
      finalizeIntakeV1PackageHandoffInTransaction(tx as never, value),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('maps a concurrent revision or package unique race to conflict without an aborted-transaction read', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockRejectedValue({ code: 'P2002' })
    const tx = { intakeV1PackageHandoff: { findFirst, create } }
    await expect(
      finalizeIntakeV1PackageHandoffInTransaction(tx as never, value),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid scoped reads without querying', async () => {
    const findFirst = vi.fn()
    await expect(
      readIntakeV1PackageHandoff({ tenantId: 'tenant', venueId: 'venue', operationId: 'bad' }, {
        intakeV1PackageHandoff: { findFirst },
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(findFirst).not.toHaveBeenCalled()
  })
})
