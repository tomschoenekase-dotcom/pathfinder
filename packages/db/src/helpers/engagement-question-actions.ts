import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type EngagementQuestionActor = {
  type: 'HUMAN'
  id: string
  role: 'OWNER' | 'MANAGER'
}

export type EngagementQuestionActionErrorCode = 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'

export class EngagementQuestionActionError extends Error {
  constructor(
    readonly code: EngagementQuestionActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'EngagementQuestionActionError'
  }
}

export type EngagementQuestionActionClient = Pick<typeof db, '$transaction'>

export const engagementQuestionSelect = {
  id: true,
  tenantId: true,
  questionType: true,
  prompt: true,
  choiceOptions: true,
  intensity: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const

type QuestionType = 'OPEN_ENDED' | 'MULTIPLE_CHOICE'

type QuestionPatch = {
  questionType?: QuestionType
  prompt?: string
  choiceOptions?: string[]
  intensity?: number
  isActive?: boolean
}

function invalid(message: string): never {
  throw new EngagementQuestionActionError('INVALID_INPUT', message)
}

function assertActor(actor: EngagementQuestionActor): void {
  if (
    actor.type !== 'HUMAN' ||
    !actor.id.trim() ||
    !(['OWNER', 'MANAGER'] as const).includes(actor.role)
  ) {
    invalid('A signed-in human owner or manager is required.')
  }
}

function normalizeQuestion(input: {
  questionType: QuestionType
  prompt: string
  choiceOptions: string[]
  intensity: number
}): Omit<typeof input, 'choiceOptions'> & { choiceOptions: string[] } {
  const prompt = input.prompt.trim()
  if (!prompt || prompt.length > 500) invalid('Question prompt must be 1 to 500 characters.')
  if (!Number.isInteger(input.intensity) || input.intensity < 1 || input.intensity > 5) {
    invalid('Question intensity must be from 1 to 5.')
  }
  const choiceOptions = input.choiceOptions.map((choice) => choice.trim())
  if (choiceOptions.some((choice) => !choice || choice.length > 100)) {
    invalid('Choice options must be 1 to 100 characters.')
  }
  if (new Set(choiceOptions).size !== choiceOptions.length) {
    invalid('Choice options must be unique.')
  }
  if (
    input.questionType === 'MULTIPLE_CHOICE' &&
    (choiceOptions.length < 2 || choiceOptions.length > 4)
  ) {
    invalid('Multiple-choice questions need 2 to 4 choice options.')
  }
  return {
    questionType: input.questionType,
    prompt,
    choiceOptions: input.questionType === 'MULTIPLE_CHOICE' ? choiceOptions : [],
    intensity: input.intensity,
  }
}

function requireScope(tenantId: string): void {
  if (!tenantId.trim()) invalid('Exact tenant scope is required.')
}

export async function createEngagementQuestionAction(input: {
  db?: EngagementQuestionActionClient
  tenantId: string
  questionType: QuestionType
  prompt: string
  choiceOptions: string[]
  intensity: number
  actor: EngagementQuestionActor
}) {
  assertActor(input.actor)
  requireScope(input.tenantId)
  const data = normalizeQuestion(input)

  return (input.db ?? db).$transaction(async (tx) => {
    const created = await tx.engagementQuestion.create({
      data: { tenantId: input.tenantId, ...data },
      select: engagementQuestionSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'engagement-question.created',
        targetType: 'EngagementQuestion',
        targetId: created.id,
        afterState: {
          questionType: created.questionType,
          intensity: created.intensity,
          isActive: created.isActive,
          choiceCount: created.choiceOptions.length,
        },
      },
      tx,
    )
    return created
  })
}

export async function updateEngagementQuestionAction(input: {
  db?: EngagementQuestionActionClient
  tenantId: string
  questionId: string
  expectedUpdatedAt: Date
  patch: QuestionPatch
  actor: EngagementQuestionActor
  now?: Date
}) {
  assertActor(input.actor)
  requireScope(input.tenantId)
  if (!input.questionId || Number.isNaN(input.expectedUpdatedAt.getTime())) {
    invalid('An exact question and valid expected revision are required.')
  }

  return (input.db ?? db).$transaction(async (tx) => {
    const existing = await tx.engagementQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId },
      select: engagementQuestionSelect,
    })
    if (!existing) {
      throw new EngagementQuestionActionError('NOT_FOUND', 'Engagement question not found.')
    }
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new EngagementQuestionActionError(
        'CONFLICT',
        'Question changed; refresh and try again.',
      )
    }
    const normalized = normalizeQuestion({
      questionType: input.patch.questionType ?? existing.questionType,
      prompt: input.patch.prompt ?? existing.prompt,
      choiceOptions: input.patch.choiceOptions ?? existing.choiceOptions,
      intensity: input.patch.intensity ?? existing.intensity,
    })
    const updatedAt = new Date(
      Math.max((input.now ?? new Date()).getTime(), existing.updatedAt.getTime() + 1),
    )
    const changed = await tx.engagementQuestion.updateMany({
      where: {
        id: input.questionId,
        tenantId: input.tenantId,
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        ...normalized,
        ...(input.patch.isActive !== undefined ? { isActive: input.patch.isActive } : {}),
        updatedAt,
      },
    })
    if (changed.count !== 1) {
      throw new EngagementQuestionActionError(
        'CONFLICT',
        'Question changed; refresh and try again.',
      )
    }
    const updated = await tx.engagementQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId },
      select: engagementQuestionSelect,
    })
    if (!updated) {
      throw new EngagementQuestionActionError('NOT_FOUND', 'Engagement question not found.')
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'engagement-question.updated',
        targetType: 'EngagementQuestion',
        targetId: updated.id,
        beforeState: {
          questionType: existing.questionType,
          intensity: existing.intensity,
          isActive: existing.isActive,
          choiceCount: existing.choiceOptions.length,
        },
        afterState: {
          questionType: updated.questionType,
          intensity: updated.intensity,
          isActive: updated.isActive,
          choiceCount: updated.choiceOptions.length,
        },
      },
      tx,
    )
    return updated
  })
}

export async function deleteEngagementQuestionAction(input: {
  db?: EngagementQuestionActionClient
  tenantId: string
  questionId: string
  expectedUpdatedAt: Date
  actor: EngagementQuestionActor
}): Promise<{ id: string }> {
  assertActor(input.actor)
  requireScope(input.tenantId)
  if (!input.questionId || Number.isNaN(input.expectedUpdatedAt.getTime())) {
    invalid('An exact question and valid expected revision are required.')
  }

  return (input.db ?? db).$transaction(async (tx) => {
    const existing = await tx.engagementQuestion.findFirst({
      where: { id: input.questionId, tenantId: input.tenantId },
      select: engagementQuestionSelect,
    })
    if (!existing) {
      throw new EngagementQuestionActionError('NOT_FOUND', 'Engagement question not found.')
    }
    if (existing.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new EngagementQuestionActionError(
        'CONFLICT',
        'Question changed; refresh and try again.',
      )
    }
    const deleted = await tx.engagementQuestion.deleteMany({
      where: {
        id: input.questionId,
        tenantId: input.tenantId,
        updatedAt: input.expectedUpdatedAt,
      },
    })
    if (deleted.count !== 1) {
      throw new EngagementQuestionActionError(
        'CONFLICT',
        'Question changed; refresh and try again.',
      )
    }
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'engagement-question.deleted',
        targetType: 'EngagementQuestion',
        targetId: existing.id,
        beforeState: {
          questionType: existing.questionType,
          intensity: existing.intensity,
          isActive: existing.isActive,
          choiceCount: existing.choiceOptions.length,
        },
      },
      tx,
    )
    return { id: existing.id }
  })
}
