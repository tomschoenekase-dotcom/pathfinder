import {
  DEFAULT_GLOBAL_AI_CONTROL,
  GLOBAL_AI_CONTROL_KEY,
  globalAiControlValueSchema,
  parseGlobalAiControlValue,
  type GlobalAiControlValue,
} from '@pathfinder/config/incident-control'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>
export type GlobalAiControlActionClient = Pick<typeof db, '$transaction'>

export type GlobalAiControlActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type GlobalAiControlActionErrorCode = 'CONFLICT' | 'INVALID_INPUT'

export class GlobalAiControlActionError extends Error {
  constructor(
    readonly code: GlobalAiControlActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GlobalAiControlActionError'
  }
}

export type GlobalAiControlState = GlobalAiControlValue & {
  configured: boolean
  malformed: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

export class GlobalAiAdmissionError extends Error {
  readonly code:
    | 'global-ai-paused'
    | 'global-ai-control-malformed'
    | 'global-ai-control-unavailable'

  constructor(code: GlobalAiAdmissionError['code']) {
    super('Global AI admission is unavailable')
    this.name = 'GlobalAiAdmissionError'
    this.code = code
  }
}

export async function readGlobalAiControl(
  client: PlatformConfigClient = db,
): Promise<GlobalAiControlState> {
  const row = await client.platformConfig.findUnique({
    where: { key: GLOBAL_AI_CONTROL_KEY },
    select: { value: true, updatedAt: true, updatedBy: true },
  })

  if (!row) {
    return {
      ...DEFAULT_GLOBAL_AI_CONTROL,
      configured: false,
      malformed: false,
      updatedAt: null,
      updatedBy: null,
    }
  }

  const value = parseGlobalAiControlValue(row.value)
  if (!value) {
    return {
      ...DEFAULT_GLOBAL_AI_CONTROL,
      paused: true,
      configured: true,
      malformed: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    }
  }

  return {
    ...value,
    configured: true,
    malformed: false,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

export async function assertGlobalAiAvailable(client: PlatformConfigClient = db): Promise<void> {
  let control: GlobalAiControlState
  try {
    control = await readGlobalAiControl(client)
  } catch {
    throw new GlobalAiAdmissionError('global-ai-control-unavailable')
  }
  if (control.malformed) throw new GlobalAiAdmissionError('global-ai-control-malformed')
  if (control.paused) throw new GlobalAiAdmissionError('global-ai-paused')
}

function actionError(code: GlobalAiControlActionErrorCode, message: string): never {
  throw new GlobalAiControlActionError(code, message)
}

function conflict(): never {
  actionError('CONFLICT', 'Global AI control changed; refresh and try again.')
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

export async function setGlobalAiControlAction(
  input: {
    paused: boolean
    reason: string
    expectedUpdatedAt: Date | null
    actor: GlobalAiControlActor
  },
  client: GlobalAiControlActionClient = db,
) {
  if (
    !input.actor ||
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim() ||
    typeof input.paused !== 'boolean' ||
    (input.expectedUpdatedAt !== null &&
      (!(input.expectedUpdatedAt instanceof Date) ||
        Number.isNaN(input.expectedUpdatedAt.getTime())))
  ) {
    actionError('INVALID_INPUT', 'A human platform administrator and exact revision are required.')
  }

  const parsedValue = globalAiControlValueSchema.safeParse({
    schemaVersion: 1,
    paused: input.paused,
    reason: input.reason,
  })
  if (!parsedValue.success || parsedValue.data.reason === null) {
    actionError('INVALID_INPUT', 'An internal reason of 1 to 500 characters is required.')
  }
  const value = parsedValue.data

  try {
    return await client.$transaction(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as typeof db
      const before = await readGlobalAiControl(transaction)
      if (!before.configured && input.expectedUpdatedAt !== null) conflict()
      if (
        before.configured &&
        (input.expectedUpdatedAt === null ||
          before.updatedAt?.getTime() !== input.expectedUpdatedAt.getTime())
      ) {
        conflict()
      }

      if (!before.malformed && before.paused === value.paused && before.reason === value.reason) {
        return { ...before, replayed: true as const }
      }

      const nextUpdatedAt = new Date(
        before.updatedAt ? Math.max(Date.now(), before.updatedAt.getTime() + 1) : Date.now(),
      )

      if (before.configured) {
        if (!before.updatedAt) conflict()
        const updated = await transaction.platformConfig.updateMany({
          where: { key: GLOBAL_AI_CONTROL_KEY, updatedAt: before.updatedAt },
          data: { value, updatedBy: input.actor.id, updatedAt: nextUpdatedAt },
        })
        if (updated.count !== 1) conflict()
      } else {
        await transaction.platformConfig.create({
          data: {
            key: GLOBAL_AI_CONTROL_KEY,
            value,
            updatedBy: input.actor.id,
            updatedAt: nextUpdatedAt,
          },
        })
      }

      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: value.paused ? 'admin.global-ai.paused' : 'admin.global-ai.resumed',
          targetType: 'PlatformConfig',
          targetId: GLOBAL_AI_CONTROL_KEY,
          beforeState: {
            paused: before.paused,
            reason: before.reason,
            malformed: before.malformed,
          },
          afterState: { paused: value.paused, reason: value.reason, malformed: false },
        },
        transaction,
      )

      return {
        ...value,
        configured: true,
        malformed: false,
        updatedAt: nextUpdatedAt,
        updatedBy: input.actor.id,
        replayed: false as const,
      }
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) conflict()
    throw error
  }
}
