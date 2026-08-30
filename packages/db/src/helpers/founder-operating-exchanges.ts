import { createHash } from 'node:crypto'

import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const id = z.string().trim().min(1).max(191)
const intent = z.enum([
  'TOP_PRIORITY',
  'DECISIONS',
  'INCIDENTS',
  'AGENT_ACTIVITY',
  'CUSTOMER_ISSUES',
  'CHANGES',
  'COSTS',
  'DIRECTIVE',
])
const disposition = z.enum(['ANSWERED', 'RECORDED_FOR_TRIAGE'])
const evidenceItem = z
  .object({
    label: z.string().trim().min(1).max(300),
    detail: z.string().trim().min(1).max(2000),
    href: z.string().trim().min(1).max(1000),
    scope: z.enum(['PLATFORM', 'TENANT']),
    objectType: z.string().trim().min(1).max(100),
    objectId: z.string().trim().min(1).max(191).nullable(),
    tenantId: z.string().trim().min(1).max(191).nullable(),
    venueId: z.string().trim().min(1).max(191).nullable(),
  })
  .strict()

const snapshot = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    boundedSnapshot: z
      .object({ limit: z.number().int().min(1).max(100), hasMore: z.boolean() })
      .strict(),
    metrics: z
      .object({
        decisions: z.number().int().nonnegative(),
        criticalRisks: z.number().int().nonnegative(),
        workingAgents: z.number().int().nonnegative(),
        blockedAgents: z.number().int().nonnegative(),
        customerItems: z.number().int().nonnegative(),
      })
      .strict(),
    changesSinceLastReview: z
      .object({
        criticalRisks: z.number().int().nonnegative(),
        decisions: z.number().int().nonnegative(),
        completedAgents: z.number().int().nonnegative(),
        outcomes: z.number().int().nonnegative(),
        customerItems: z.number().int().nonnegative(),
      })
      .strict(),
    operatingCosts: z
      .object({
        windowDays: z.number().int().positive(),
        knownOperatingCostUsd: z.string().regex(/^\d+\.\d{8}$/u),
        priorKnownOperatingCostUsd: z.string().regex(/^\d+\.\d{8}$/u),
        changeUsd: z.string().regex(/^-?\d+\.\d{8}$/u),
        coverageComplete: z.boolean(),
        anomalyThreshold: z.literal('UNRESOLVED'),
      })
      .strict(),
    authority: z
      .object({
        canExecute: z.literal(false),
        canApprove: z.literal(false),
        canContactCustomers: z.literal(false),
        canChangePricing: z.literal(false),
        canSpendMoney: z.literal(false),
        canMutatePolicy: z.literal(false),
      })
      .strict(),
  })
  .strict()

const recordInput = z
  .object({
    operationId: z.string().uuid(),
    operatorUserId: id,
    prompt: z.string().trim().min(1).max(10_000),
    intent,
    disposition,
    responseTitle: z.string().trim().min(1).max(500),
    responseBody: z.string().trim().min(1).max(10_000),
    evidence: z.array(evidenceItem).max(10),
    snapshot,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.intent === 'DIRECTIVE' ? 'RECORDED_FOR_TRIAGE' : 'ANSWERED'
    if (value.disposition !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'Disposition does not match the operating intent boundary.',
      })
    }
  })

export type RecordFounderOperatingExchangeInput = z.input<typeof recordInput>
export type FounderOperatingExchangeClient = Pick<
  typeof db,
  '$transaction' | 'founderOperatingExchange'
>

export class FounderOperatingExchangeError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'FounderOperatingExchangeError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function snapshotHash(input: z.output<typeof recordInput>) {
  return createHash('sha256')
    .update(
      canonicalJson({
        operationId: input.operationId,
        prompt: input.prompt,
        intent: input.intent,
        disposition: input.disposition,
        responseTitle: input.responseTitle,
        responseBody: input.responseBody,
        evidence: input.evidence,
        snapshot: input.snapshot,
      }),
    )
    .digest('hex')
}

const projection = {
  id: true,
  operationId: true,
  prompt: true,
  intent: true,
  disposition: true,
  responseTitle: true,
  responseBody: true,
  evidence: true,
  snapshot: true,
  snapshotHash: true,
  createdAt: true,
} as const

function replayExisting<T extends { operatorUserId: string; prompt: string }>(
  existing: T,
  input: z.output<typeof recordInput>,
) {
  const { operatorUserId, ...exchange } = existing
  if (operatorUserId !== input.operatorUserId || existing.prompt !== input.prompt) {
    throw new FounderOperatingExchangeError(
      'CONFLICT',
      'Operating exchange operation was already used for different work.',
    )
  }
  return { exchange, replayed: true as const }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

export async function readFounderOperatingExchange(
  operationId: string,
  operatorUserId: string,
  client: FounderOperatingExchangeClient = db,
) {
  return client.founderOperatingExchange.findFirst({
    where: { operationId, operatorUserId },
    select: projection,
  })
}

export async function listFounderOperatingExchanges(
  limit = 20,
  client: FounderOperatingExchangeClient = db,
) {
  const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)))
  return client.founderOperatingExchange.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: boundedLimit,
    select: projection,
  })
}

export async function recordFounderOperatingExchange(
  rawInput: RecordFounderOperatingExchangeInput,
  client: FounderOperatingExchangeClient = db,
) {
  const input = recordInput.parse(rawInput)
  try {
    return await client.$transaction(async (transaction) => {
      const existing = await transaction.founderOperatingExchange.findUnique({
        where: { operationId: input.operationId },
        select: { ...projection, operatorUserId: true },
      })
      if (existing) return replayExisting(existing, input)

      const created = await transaction.founderOperatingExchange.create({
        data: {
          operationId: input.operationId,
          operatorUserId: input.operatorUserId,
          prompt: input.prompt,
          intent: input.intent,
          disposition: input.disposition,
          responseTitle: input.responseTitle,
          responseBody: input.responseBody,
          evidence: input.evidence,
          snapshot: input.snapshot,
          snapshotHash: snapshotHash(input),
        },
        select: projection,
      })
      await writeAuditLogStrict(
        {
          actorId: input.operatorUserId,
          actorRole: 'PLATFORM_ADMIN',
          action: 'founder-operating-exchange.recorded',
          targetType: 'FounderOperatingExchange',
          targetId: created.id,
          afterState: {
            intent: input.intent,
            disposition: input.disposition,
            snapshotHash: created.snapshotHash,
            authority: input.snapshot.authority,
          },
        },
        transaction,
      )
      return { exchange: created, replayed: false as const }
    })
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const existing = await client.founderOperatingExchange.findUnique({
      where: { operationId: input.operationId },
      select: { ...projection, operatorUserId: true },
    })
    if (!existing) throw error
    return replayExisting(existing, input)
  }
}
