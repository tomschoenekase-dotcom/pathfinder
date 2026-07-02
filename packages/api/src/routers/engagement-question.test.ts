import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { engagementQuestionRouter } from './engagement-question'

const engagementQuestionFindMany = vi.fn()
const engagementQuestionFindFirst = vi.fn()
const engagementQuestionCreate = vi.fn()
const engagementQuestionUpdateMany = vi.fn()
const engagementQuestionDeleteMany = vi.fn()

const mockDb = {
  engagementQuestion: {
    findMany: engagementQuestionFindMany,
    findFirst: engagementQuestionFindFirst,
    create: engagementQuestionCreate,
    updateMany: engagementQuestionUpdateMany,
    deleteMany: engagementQuestionDeleteMany,
  },
} as unknown as TRPCContext['db']

const baseCtx = { db: mockDb, headers: new Headers() }

function managerCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'MANAGER',
      isPlatformAdmin: false,
    },
  }
}

function staffCtx(): TRPCContext {
  return {
    ...baseCtx,
    session: {
      userId: 'user_1',
      activeTenantId: 'tenant_1',
      role: 'STAFF',
      isPlatformAdmin: false,
    },
  }
}

const testRouter = router({ engagementQuestion: engagementQuestionRouter })

const QUESTION_ID = 'ckengagequestion000000000001'

const questionRow = {
  id: QUESTION_ID,
  tenantId: 'tenant_1',
  questionType: 'MULTIPLE_CHOICE',
  prompt: 'Ask about favorite part.',
  choiceOptions: ['exhibit', 'food court'],
  intensity: 3,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('engagementQuestion router', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('list scopes by tenantId', async () => {
    engagementQuestionFindMany.mockResolvedValueOnce([questionRow])

    const caller = testRouter.createCaller(staffCtx())
    const result = await caller.engagementQuestion.list()

    expect(result).toEqual([questionRow])
    expect(engagementQuestionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1' },
      }),
    )
  })

  it('create rejects multiple-choice questions with fewer than 2 options', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.engagementQuestion.create({
        questionType: 'MULTIPLE_CHOICE',
        prompt: 'Pick one.',
        choiceOptions: ['only one'],
        intensity: 3,
      }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'BAD_REQUEST' }))
  })

  it('create rejects multiple-choice questions with more than 4 options', async () => {
    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.engagementQuestion.create({
        questionType: 'MULTIPLE_CHOICE',
        prompt: 'Pick one.',
        choiceOptions: ['a', 'b', 'c', 'd', 'e'],
        intensity: 3,
      }),
    ).rejects.toThrow()
  })

  it('create stores an empty options array for open-ended questions', async () => {
    engagementQuestionCreate.mockResolvedValueOnce({
      ...questionRow,
      questionType: 'OPEN_ENDED',
      choiceOptions: [],
    })

    const caller = testRouter.createCaller(managerCtx())
    await caller.engagementQuestion.create({
      questionType: 'OPEN_ENDED',
      prompt: 'Ask about wayfinding.',
      choiceOptions: ['ignored', 'also ignored'],
      intensity: 2,
    })

    expect(engagementQuestionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ choiceOptions: [] }),
      }),
    )
  })

  it('update validates the merged record rather than the patch alone', async () => {
    engagementQuestionFindFirst
      .mockResolvedValueOnce(questionRow)
      .mockResolvedValueOnce({ ...questionRow, intensity: 5 })
    engagementQuestionUpdateMany.mockResolvedValueOnce({ count: 1 })

    const caller = testRouter.createCaller(managerCtx())
    const result = await caller.engagementQuestion.update({ id: QUESTION_ID, intensity: 5 })

    expect(result).toMatchObject({ intensity: 5 })
    expect(engagementQuestionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: QUESTION_ID, tenantId: 'tenant_1' },
        data: { intensity: 5 },
      }),
    )
  })

  it('update throws NOT_FOUND for a question outside the tenant', async () => {
    engagementQuestionFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(
      caller.engagementQuestion.update({ id: QUESTION_ID, intensity: 5 }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }))
  })

  it('delete throws NOT_FOUND for a question outside the tenant', async () => {
    engagementQuestionFindFirst.mockResolvedValueOnce(null)

    const caller = testRouter.createCaller(managerCtx())

    await expect(caller.engagementQuestion.delete({ id: QUESTION_ID })).rejects.toThrowError(
      expect.objectContaining<Partial<TRPCError>>({ code: 'NOT_FOUND' }),
    )
  })
})
