import { z } from 'zod'

import type { AiProviderId } from '@pathfinder/ai'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const AI_PROVIDER_HEALTH_CONTROL_KEY = 'ai-provider-health-control-v1' as const

// Keep runtime validation independent of @pathfinder/ai module initialization: several consumers
// deliberately replace that package with narrow provider mocks. The exhaustive record makes an
// addition to the provider-id union an explicit compile-time reconciliation point here.
const providerRegistryCoverage = {
  anthropic: true,
  openai: true,
} as const satisfies Record<AiProviderId, true>
const providerIds = Object.keys(providerRegistryCoverage) as [AiProviderId, ...AiProviderId[]]
const providerSchema = z.enum(providerIds)
const storedOverrideSchema = z
  .object({
    provider: providerSchema,
    reason: z.string().trim().min(1).max(500),
    expiresAt: z.string().datetime(),
  })
  .strict()

const storedValueSchema = z
  .object({
    schemaVersion: z.literal(1),
    overrides: z.array(storedOverrideSchema).max(providerIds.length),
  })
  .strict()
  .superRefine((value, ctx) => {
    const providers = value.overrides.map((override) => override.provider)
    if (new Set(providers).size !== providers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider overrides must be unique.' })
    }
  })

type PlatformConfigClient = Pick<typeof db, 'platformConfig'>
export type AiProviderHealthControlActionClient = Pick<typeof db, '$transaction'>
export type AiProviderHealthControlActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type AiProviderHealthOverrideState = {
  provider: AiProviderId
  reason: string
  expiresAt: Date
  active: boolean
}

export type AiProviderHealthControlState = {
  schemaVersion: 1
  overrides: AiProviderHealthOverrideState[]
  activeUnhealthyProviders: AiProviderId[]
  configured: boolean
  malformed: boolean
  updatedAt: Date | null
  updatedBy: string | null
}

export type AiProviderHealthControlActionErrorCode = 'CONFLICT' | 'INVALID_INPUT'

export class AiProviderHealthControlActionError extends Error {
  constructor(
    readonly code: AiProviderHealthControlActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AiProviderHealthControlActionError'
  }
}

export class AiProviderHealthControlReadError extends Error {
  constructor(readonly code: 'control-unavailable' | 'control-malformed') {
    super('AI provider health control is unavailable')
    this.name = 'AiProviderHealthControlReadError'
  }
}

function emptyState(overrides: Partial<AiProviderHealthControlState> = {}) {
  return {
    schemaVersion: 1 as const,
    overrides: [],
    activeUnhealthyProviders: [],
    configured: false,
    malformed: false,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  }
}

export async function readAiProviderHealthControl(
  client: PlatformConfigClient = db,
  now = new Date(),
): Promise<AiProviderHealthControlState> {
  const row = await client.platformConfig.findUnique({
    where: { key: AI_PROVIDER_HEALTH_CONTROL_KEY },
    select: { value: true, updatedAt: true, updatedBy: true },
  })
  if (!row) return emptyState()

  const parsed = storedValueSchema.safeParse(row.value)
  if (!parsed.success) {
    return emptyState({
      configured: true,
      malformed: true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    })
  }

  const overrides = parsed.data.overrides.map((override) => {
    const expiresAt = new Date(override.expiresAt)
    return { ...override, expiresAt, active: expiresAt.getTime() > now.getTime() }
  })
  return {
    schemaVersion: 1,
    overrides,
    activeUnhealthyProviders: overrides
      .filter((override) => override.active)
      .map((override) => override.provider),
    configured: true,
    malformed: false,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  }
}

export async function readActiveUnhealthyAiProviders(
  client: PlatformConfigClient = db,
  now = new Date(),
): Promise<AiProviderId[]> {
  let state: AiProviderHealthControlState
  try {
    state = await readAiProviderHealthControl(client, now)
  } catch {
    throw new AiProviderHealthControlReadError('control-unavailable')
  }
  if (state.malformed) throw new AiProviderHealthControlReadError('control-malformed')
  return state.activeUnhealthyProviders
}

function actionError(code: AiProviderHealthControlActionErrorCode, message: string): never {
  throw new AiProviderHealthControlActionError(code, message)
}

function conflict(): never {
  actionError('CONFLICT', 'AI provider health control changed; refresh and try again.')
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

export async function setAiProviderHealthOverrideAction(
  input: {
    provider: AiProviderId
    unhealthy: boolean
    reason: string
    expiresAt: Date | null
    expectedUpdatedAt: Date | null
    actor: AiProviderHealthControlActor
  },
  client: AiProviderHealthControlActionClient = db,
) {
  const actorValid =
    input.actor?.type === 'HUMAN' &&
    input.actor.role === 'PLATFORM_ADMIN' &&
    Boolean(input.actor.id.trim())
  const provider = providerSchema.safeParse(input.provider)
  const reason = z.string().trim().min(1).max(500).safeParse(input.reason)
  const revisionValid =
    input.expectedUpdatedAt === null ||
    (input.expectedUpdatedAt instanceof Date && !Number.isNaN(input.expectedUpdatedAt.getTime()))
  const expiryValid =
    !input.unhealthy ||
    (input.expiresAt instanceof Date &&
      !Number.isNaN(input.expiresAt.getTime()) &&
      input.expiresAt.getTime() > Date.now())
  if (!actorValid || !provider.success || !reason.success || !revisionValid || !expiryValid) {
    actionError(
      'INVALID_INPUT',
      'A human platform administrator, known provider, reason, exact revision, and future expiry are required.',
    )
  }

  try {
    return await client.$transaction(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as typeof db
      const before = await readAiProviderHealthControl(transaction)
      if (!before.configured && input.expectedUpdatedAt !== null) conflict()
      if (
        before.configured &&
        (input.expectedUpdatedAt === null ||
          before.updatedAt?.getTime() !== input.expectedUpdatedAt.getTime())
      ) {
        conflict()
      }

      const retained = before.malformed
        ? []
        : before.overrides.filter((override) => override.provider !== provider.data)
      const nextOverrides = input.unhealthy
        ? [
            ...retained,
            {
              provider: provider.data,
              reason: reason.data,
              expiresAt: input.expiresAt!.toISOString(),
            },
          ]
        : retained.map((override) => ({
            provider: override.provider,
            reason: override.reason,
            expiresAt: override.expiresAt.toISOString(),
          }))
      const value = storedValueSchema.parse({ schemaVersion: 1, overrides: nextOverrides })
      const current = before.overrides.find((override) => override.provider === provider.data)
      const exactReplay = input.unhealthy
        ? !before.malformed &&
          current?.reason === reason.data &&
          current.expiresAt.getTime() === input.expiresAt!.getTime()
        : !before.malformed && !current
      if (exactReplay) return { ...before, replayed: true as const }

      const nextUpdatedAt = new Date(
        before.updatedAt ? Math.max(Date.now(), before.updatedAt.getTime() + 1) : Date.now(),
      )
      if (before.configured) {
        if (!before.updatedAt) conflict()
        const updated = await transaction.platformConfig.updateMany({
          where: { key: AI_PROVIDER_HEALTH_CONTROL_KEY, updatedAt: before.updatedAt },
          data: { value, updatedBy: input.actor.id, updatedAt: nextUpdatedAt },
        })
        if (updated.count !== 1) conflict()
      } else {
        await transaction.platformConfig.create({
          data: {
            key: AI_PROVIDER_HEALTH_CONTROL_KEY,
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
          action: input.unhealthy
            ? 'admin.ai-provider.marked-unhealthy'
            : 'admin.ai-provider.restored',
          targetType: 'PlatformConfig',
          targetId: AI_PROVIDER_HEALTH_CONTROL_KEY,
          beforeState: {
            provider: provider.data,
            unhealthy: Boolean(current?.active),
            expiresAt: current?.expiresAt.toISOString() ?? null,
            malformed: before.malformed,
          },
          afterState: {
            provider: provider.data,
            unhealthy: input.unhealthy,
            expiresAt: input.unhealthy ? input.expiresAt!.toISOString() : null,
            malformed: false,
            reason: reason.data,
          },
        },
        transaction,
      )

      const returnedOverrides = value.overrides.map((override) => {
        const expiresAt = new Date(override.expiresAt)
        return {
          ...override,
          expiresAt,
          active: expiresAt.getTime() > nextUpdatedAt.getTime(),
        }
      })
      return {
        schemaVersion: 1 as const,
        overrides: returnedOverrides,
        activeUnhealthyProviders: returnedOverrides
          .filter((override) => override.active)
          .map((override) => override.provider),
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
