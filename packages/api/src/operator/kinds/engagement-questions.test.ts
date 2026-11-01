/* eslint-disable @typescript-eslint/no-explicit-any -- exact canonical-action transaction fakes */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_MCP_INPUTS,
  OPERATOR_MCP_OUTPUTS,
  OPERATOR_MCP_TOOLS,
} from '@pathfinder/contracts/operator-mcp'
import { createOperatorRegistry } from '../registry'
import { engagementQuestionsList } from '../tools/engagement-questions'
import {
  engagementQuestionCreateKind as create,
  engagementQuestionUpdateKind as update,
} from './engagement-questions'
const scope = { tenantId: 'tenant-a' }
const operationId = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
const stamp = new Date('2026-11-01T00:00:00Z')
const row = {
  id: 'question-a',
  ...scope,
  questionType: 'MULTIPLE_CHOICE' as const,
  prompt: 'Which area?',
  choiceOptions: ['Garden', 'Gallery'],
  intensity: 3,
  isActive: true,
  createdAt: stamp,
  updatedAt: stamp,
}
const createArgs = () =>
  create.parse({
    ...scope,
    operationId,
    questionType: 'MULTIPLE_CHOICE',
    prompt: row.prompt,
    choiceOptions: row.choiceOptions,
    intensity: 5,
  })
const updateArgs = (patch = {}) =>
  update.parse({
    ...scope,
    operationId,
    questionId: row.id,
    expectedUpdatedAt: stamp.toISOString(),
    isActive: false,
    ...patch,
  })
const tenant = { findUnique: vi.fn() }
const question = { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() }
const auditLog = { create: vi.fn() }
const database = {
  tenant,
  engagementQuestion: question,
  $transaction: async (run: any) => run({ engagementQuestion: question, auditLog }),
}
const context = (capabilities = ['company:read', 'customers:propose']) =>
  ({
    database,
    grant: { allTenants: false, tenantIds: ['tenant-a'], capabilities },
    actor: { type: 'HUMAN', id: 'human-a', role: 'PLATFORM_ADMIN' },
    now: new Date('2026-11-01T01:00:00Z'),
    config: { allowedUserIds: ['human-a'] },
  }) as any
beforeEach(() => {
  vi.clearAllMocks()
  tenant.findUnique.mockResolvedValue({ id: 'tenant-a' })
  question.findFirst.mockResolvedValue(row)
  question.findMany.mockResolvedValue([row])
  question.create.mockResolvedValue(row)
  question.updateMany.mockResolvedValue({ count: 1 })
  auditLog.create.mockResolvedValue({ id: 'audit-a' })
})
describe('tenant-wide engagement question operator administration', () => {
  it('requires tenant-level capabilities and refuses a venues-only credential before data access', async () => {
    const registry = createOperatorRegistry()
    for (const [tool, args] of [
      [engagementQuestionsList.name, scope],
      [create.tool, createArgs()],
      [update.tool, updateArgs()],
    ] as const) {
      await expect(
        registry.callTool(tool, args, context(['venues:read', 'venues:propose'])),
      ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    }
    expect(tenant.findUnique).not.toHaveBeenCalled()
    expect(question.findFirst).not.toHaveBeenCalled()
    expect(question.updateMany).not.toHaveBeenCalled()
    expect(create.target(createArgs())).toEqual(scope)
    expect(update.target(updateArgs())).toEqual(scope)
    expect(create.jobGrant).toBeUndefined()
    expect(update.jobGrant).toBeUndefined()
  })
  it('refuses sibling tenants before query or proposal creation', async () => {
    await expect(
      engagementQuestionsList.handler({ tenantId: 'tenant-b' }, context()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    for (const kind of [create, update])
      await expect(
        kind.authorize!({ tenantId: 'tenant-b' } as any, context()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(question.findMany).not.toHaveBeenCalled()
    expect(question.create).not.toHaveBeenCalled()
  })
  it('pages all active and disabled questions without hiding beyond 25', async () => {
    question.findMany.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => ({ ...row, id: `q-${i}`, isActive: i !== 0 })),
    )
    const first = (await engagementQuestionsList.handler(scope, context())) as any
    expect(first).toMatchObject({ complete: false, nextCursor: 'q-24' })
    expect(first.items).toHaveLength(25)
    expect(first.items[0].isActive).toBe(false)
    expect(OPERATOR_MCP_OUTPUTS['engagement.list_questions'].safeParse(first).success).toBe(true)
    expect(question.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: scope, take: 26, orderBy: { id: 'asc' } }),
    )
    question.findMany.mockResolvedValue([{ ...row, id: 'q-25' }])
    const last = (await engagementQuestionsList.handler(
      { ...scope, cursor: first.nextCursor },
      context(),
    )) as any
    expect(last).toMatchObject({ complete: true, nextCursor: null })
    expect(last.items).toHaveLength(1)
    expect(question.findFirst).toHaveBeenCalledWith({
      where: { ...scope, id: 'q-24' },
      select: { id: true },
    })
  })
  it('rejects a foreign cursor and registry-bound cursor reuse on another tenant', async () => {
    question.findFirst.mockResolvedValue(null)
    await expect(
      engagementQuestionsList.handler({ ...scope, cursor: 'foreign-question' }, context()),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    question.findFirst.mockResolvedValue(row)
    question.findMany.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => ({ ...row, id: `q-${i}` })),
    )
    const registry = createOperatorRegistry()
    const ctx = context()
    ctx.grant.tenantIds.push('tenant-b')
    const page = (await registry.callTool('engagement.list_questions', scope, ctx)) as any
    await expect(
      registry.callTool(
        'engagement.list_questions',
        { tenantId: 'tenant-b', cursor: page.nextCursor },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
  it('creates through the canonical normalized action and audits the tenant-scoped write', async () => {
    await create.apply(createArgs(), context())
    expect(question.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          ...scope,
          questionType: 'MULTIPLE_CHOICE',
          prompt: 'Which area?',
          choiceOptions: row.choiceOptions,
          intensity: 5,
        },
      }),
    )
    expect(auditLog.create).toHaveBeenCalled()
  })
  it('disables reversibly using the exact atomic tenant and timestamp compare-and-swap', async () => {
    question.findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, isActive: false, updatedAt: new Date(stamp.getTime() + 1) })
    const outcome = await update.apply(updateArgs(), context())
    expect(outcome.result).toMatchObject({ questionId: row.id, question: { isActive: false } })
    expect(question.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, ...scope, updatedAt: stamp },
        data: expect.objectContaining({ isActive: false }),
      }),
    )
    question.findFirst.mockResolvedValue(row)
    await update.apply(
      updateArgs({
        isActive: true,
        questionType: 'OPEN_ENDED',
        prompt: 'What next?',
        intensity: 1,
        choiceOptions: [],
      }),
      context(),
    )
    expect(question.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isActive: true,
          questionType: 'OPEN_ENDED',
          prompt: 'What next?',
          intensity: 1,
          choiceOptions: [],
        }),
      }),
    )
  })
  it('refuses stale read and concurrent write races without audit or partial update', async () => {
    question.findFirst.mockResolvedValue({ ...row, updatedAt: new Date(stamp.getTime() + 1) })
    await expect(update.apply(updateArgs(), context())).rejects.toMatchObject({ code: 'STALE' })
    expect(question.updateMany).not.toHaveBeenCalled()
    expect(auditLog.create).not.toHaveBeenCalled()
    question.findFirst.mockResolvedValue(row)
    question.updateMany.mockResolvedValue({ count: 0 })
    await expect(update.apply(updateArgs(), context())).rejects.toMatchObject({ code: 'STALE' })
    expect(auditLog.create).not.toHaveBeenCalled()
  })
  it('refuses missing tenant question and invalid final merged multiple-choice options', async () => {
    question.findFirst.mockResolvedValue(null)
    await expect(update.apply(updateArgs(), context())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    question.findFirst.mockResolvedValue(row)
    await expect(
      update.apply(updateArgs({ choiceOptions: ['Only one'] }), context()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(question.updateMany).not.toHaveBeenCalled()
  })
  it('rejects invalid fields, no-op updates and duplicate options; advertises tenant scope', () => {
    const input = OPERATOR_MCP_INPUTS['engagement.propose_question_create']
    for (const patch of [
      { intensity: 6 },
      { questionType: 'MULTIPLE_CHOICE', choiceOptions: ['same', 'same'] },
      { choiceOptions: ['a'] },
      { venueId: 'venue-a' },
    ])
      expect(input.safeParse({ ...createArgs(), ...patch }).success).toBe(false)
    expect(
      OPERATOR_MCP_INPUTS['engagement.propose_question_update'].safeParse({
        ...scope,
        operationId,
        questionId: row.id,
        expectedUpdatedAt: stamp.toISOString(),
      }).success,
    ).toBe(false)
    for (const name of [engagementQuestionsList.name, create.tool, update.tool])
      expect(OPERATOR_MCP_TOOLS.find((tool) => tool.name === name)?.scope).toBe('tenant')
  })
})
