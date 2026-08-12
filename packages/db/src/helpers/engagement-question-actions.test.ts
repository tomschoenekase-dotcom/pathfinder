import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createEngagementQuestionAction,
  deleteEngagementQuestionAction,
  EngagementQuestionActionError,
  updateEngagementQuestionAction,
} from './engagement-question-actions'

const revision = new Date('2026-08-11T21:00:00.000Z')
const nextRevision = new Date('2026-08-11T21:01:00.000Z')
const row = {
  id: 'question_1',
  tenantId: 'tenant_1',
  questionType: 'MULTIPLE_CHOICE' as const,
  prompt: 'What should visitors see first?',
  choiceOptions: ['Gallery', 'Garden'],
  intensity: 3,
  isActive: true,
  createdAt: revision,
  updatedAt: revision,
}

const create = vi.fn()
const findFirst = vi.fn()
const updateMany = vi.fn()
const deleteMany = vi.fn()
const auditCreate = vi.fn()
const tx = {
  engagementQuestion: { create, findFirst, updateMany, deleteMany },
  auditLog: { create: auditCreate },
}
const client = {
  $transaction: vi.fn(async (operation: (transaction: typeof tx) => unknown) => operation(tx)),
}
const actor = { type: 'HUMAN' as const, id: 'user_1', role: 'MANAGER' as const }

describe('engagement question domain actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auditCreate.mockResolvedValue({ id: 'audit_1' })
  })

  it('creates normalized content and strict sanitized audit evidence atomically', async () => {
    create.mockResolvedValue({ ...row, questionType: 'OPEN_ENDED', choiceOptions: [] })

    await createEngagementQuestionAction({
      db: client as never,
      tenantId: 'tenant_1',
      questionType: 'OPEN_ENDED',
      prompt: '  What would help?  ',
      choiceOptions: ['ignored', 'values'],
      intensity: 2,
      actor,
    })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prompt: 'What would help?', choiceOptions: [] }),
      }),
    )
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'engagement-question.created',
          tenantId: 'tenant_1',
          afterState: expect.not.objectContaining({ prompt: expect.anything() }),
        }),
      }),
    )
  })

  it('rejects duplicate choices before opening a transaction', async () => {
    await expect(
      createEngagementQuestionAction({
        db: client as never,
        tenantId: 'tenant_1',
        questionType: 'MULTIPLE_CHOICE',
        prompt: 'Pick one',
        choiceOptions: ['Same', 'Same'],
        intensity: 3,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('uses exact tenant and revision CAS, then audits the sanitized change', async () => {
    findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, intensity: 5, updatedAt: nextRevision })
    updateMany.mockResolvedValue({ count: 1 })

    const result = await updateEngagementQuestionAction({
      db: client as never,
      tenantId: 'tenant_1',
      questionId: row.id,
      expectedUpdatedAt: revision,
      patch: { intensity: 5 },
      actor,
      now: nextRevision,
    })

    expect(result.intensity).toBe(5)
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, tenantId: 'tenant_1', updatedAt: revision },
      }),
    )
    expect(auditCreate).toHaveBeenCalledOnce()
  })

  it('fails closed on a CAS race without audit evidence', async () => {
    findFirst.mockResolvedValue(row)
    updateMany.mockResolvedValue({ count: 0 })

    await expect(
      updateEngagementQuestionAction({
        db: client as never,
        tenantId: 'tenant_1',
        questionId: row.id,
        expectedUpdatedAt: revision,
        patch: { intensity: 5 },
        actor,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it('hard deletion requires exact scope and revision and is audited in the transaction', async () => {
    findFirst.mockResolvedValue(row)
    deleteMany.mockResolvedValue({ count: 1 })

    await expect(
      deleteEngagementQuestionAction({
        db: client as never,
        tenantId: 'tenant_1',
        questionId: row.id,
        expectedUpdatedAt: revision,
        actor,
      }),
    ).resolves.toEqual({ id: row.id })
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: row.id, tenantId: 'tenant_1', updatedAt: revision },
    })
    expect(auditCreate).toHaveBeenCalledOnce()
  })

  it('rejects non-manager actors at the domain boundary', async () => {
    await expect(
      deleteEngagementQuestionAction({
        db: client as never,
        tenantId: 'tenant_1',
        questionId: row.id,
        expectedUpdatedAt: revision,
        actor: { type: 'HUMAN', id: 'staff_1', role: 'STAFF' } as never,
      }),
    ).rejects.toBeInstanceOf(EngagementQuestionActionError)
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
