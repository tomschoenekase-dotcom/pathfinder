import { createHash } from 'node:crypto'

import type { InputJsonValue } from '@prisma/client/runtime/library'
import { z } from 'zod'

import {
  IntakeDiscrepancy,
  IntakeEvidence,
  WebsiteIntakeBounds,
} from '@pathfinder/contracts/intake-engine'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN = 4

const terminalInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    runId: z.string().trim().min(1).max(191),
    priorReceiptId: z.string().uuid().optional(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceUriHash: z.string().regex(/^[a-f0-9]{64}$/u),
    bounds: WebsiteIntakeBounds,
    outcome: z.enum(['SUCCEEDED', 'INACCESSIBLE', 'FAILED']),
    researchSnapshot: z.record(z.unknown()).optional(),
    candidateSnapshot: z.unknown().optional(),
    evidence: z.array(IntakeEvidence).max(5_000).default([]),
    discrepancies: z.array(IntakeDiscrepancy).max(1_000).default([]),
    attemptedFetches: z.number().int().min(0).max(10_000),
    fetchedPages: z.number().int().min(0).max(100),
    fetchedBytes: z.number().int().min(0).max(1_000_000_000),
    estimatedCostUnits: z.number().int().min(0).max(1_000_000),
    latencyMs: z.number().int().min(0).max(300_000),
    errorCode: z.string().trim().min(1).max(64).optional(),
    errorMessage: z.string().trim().min(1).max(500).optional(),
    createdBy: z.string().trim().min(1).max(191),
  })
  .strict()
  .superRefine((value, context) => {
    const successful = value.outcome === 'SUCCEEDED'
    if (
      successful !== Boolean(value.researchSnapshot) ||
      successful === Boolean(value.errorCode) ||
      successful === Boolean(value.errorMessage)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcome'],
        message: 'Website research terminal evidence does not match its outcome.',
      })
    }
    if (!successful && (value.evidence.length > 0 || value.discrepancies.length > 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'Failed or inaccessible research cannot claim extracted evidence.',
      })
    }
  })

export type RecordWebsiteResearchReceiptInput = z.infer<typeof terminalInput>

type WebsiteResearchActionClient = Pick<
  typeof db,
  | 'intakeRun'
  | 'intakeWebsiteResearchReceipt'
  | 'intakeEvidenceRecord'
  | 'intakeRunEvent'
  | 'auditLog'
  | '$transaction'
>

export class IntakeWebsiteResearchActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT_REACHED',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeWebsiteResearchActionError'
  }
}

function json(value: unknown): InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as InputJsonValue
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function exactJson(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right)
}

function snapshotSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

const receiptSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  runId: true,
  priorReceiptId: true,
  requestHash: true,
  sourceUriHash: true,
  outcome: true,
  bounds: true,
  researchSnapshot: true,
  candidateSnapshot: true,
  attemptedFetches: true,
  fetchedPages: true,
  fetchedBytes: true,
  estimatedCostUnits: true,
  latencyMs: true,
  errorCode: true,
  errorMessage: true,
  createdBy: true,
  createdAt: true,
} as const

function exactReplay(
  receipt: Awaited<
    ReturnType<WebsiteResearchActionClient['intakeWebsiteResearchReceipt']['findUnique']>
  >,
  input: RecordWebsiteResearchReceiptInput,
) {
  return Boolean(
    receipt &&
    receipt.tenantId === input.tenantId &&
    receipt.venueId === input.venueId &&
    receipt.runId === input.runId &&
    receipt.priorReceiptId === (input.priorReceiptId ?? null) &&
    receipt.requestHash === input.requestHash &&
    receipt.sourceUriHash === input.sourceUriHash &&
    receipt.outcome === input.outcome &&
    exactJson(receipt.bounds, input.bounds) &&
    exactJson(receipt.researchSnapshot, input.researchSnapshot ?? null) &&
    exactJson(receipt.candidateSnapshot, input.candidateSnapshot ?? null) &&
    receipt.attemptedFetches === input.attemptedFetches &&
    receipt.fetchedPages === input.fetchedPages &&
    receipt.fetchedBytes === input.fetchedBytes &&
    receipt.estimatedCostUnits === input.estimatedCostUnits &&
    receipt.latencyMs === input.latencyMs &&
    receipt.errorCode === (input.errorCode ?? null) &&
    receipt.errorMessage === (input.errorMessage ?? null) &&
    receipt.createdBy === input.createdBy,
  )
}

function result(receipt: { id: string; outcome: string; createdAt: Date }, replayed: boolean) {
  return {
    receiptId: receipt.id,
    outcome: receipt.outcome,
    createdAt: receipt.createdAt,
    replayed,
    evidenceRecorded: receipt.outcome === 'SUCCEEDED',
    packageDraftCreated: false as const,
    autoApproved: false as const,
    autoApplied: false as const,
    autoPublished: false as const,
  }
}

export async function recordWebsiteResearchReceiptAction(
  rawInput: RecordWebsiteResearchReceiptInput,
  client: WebsiteResearchActionClient = db,
) {
  const parsed = terminalInput.safeParse(rawInput)
  if (!parsed.success) {
    throw new IntakeWebsiteResearchActionError(
      'INVALID_INPUT',
      'Invalid website research terminal evidence.',
    )
  }
  const input = parsed.data
  if (
    snapshotSize(input.researchSnapshot) > 5_000_000 ||
    snapshotSize(input.candidateSnapshot) > 2_000_000
  ) {
    throw new IntakeWebsiteResearchActionError(
      'INVALID_INPUT',
      'Website research snapshots exceed the retained evidence bounds.',
    )
  }

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-website-research:${input.tenantId}:${input.venueId}:${input.runId}`}, 0))`
    const replay = await tx.intakeWebsiteResearchReceipt.findUnique({
      where: { id: input.operationId },
      select: receiptSelect,
    })
    if (replay) {
      if (!exactReplay(replay, input)) {
        throw new IntakeWebsiteResearchActionError(
          'CONFLICT',
          'The operation ID is already bound to different website research evidence.',
        )
      }
      return result(replay, true)
    }

    const run = await tx.intakeRun.findFirst({
      where: { id: input.runId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, sourceKind: true, websiteUri: true },
    })
    if (!run) {
      throw new IntakeWebsiteResearchActionError('NOT_FOUND', 'Website intake run not found.')
    }
    if (run.sourceKind !== 'WEBSITE' || !run.websiteUri) {
      throw new IntakeWebsiteResearchActionError(
        'INVALID_INPUT',
        'Only a website intake run can receive website research evidence.',
      )
    }
    const storedUriHash = createHash('sha256').update(run.websiteUri).digest('hex')
    if (storedUriHash !== input.sourceUriHash) {
      throw new IntakeWebsiteResearchActionError(
        'CONFLICT',
        'The website intake source changed before research evidence was recorded.',
      )
    }

    const priorReceipts = await tx.intakeWebsiteResearchReceipt.findMany({
      where: { tenantId: input.tenantId, venueId: input.venueId, runId: input.runId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN,
      select: { id: true, outcome: true },
    })
    if (priorReceipts.length >= MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN) {
      throw new IntakeWebsiteResearchActionError(
        'LIMIT_REACHED',
        'This website intake run has reached its bounded research attempt limit.',
      )
    }
    const latestReceiptId = priorReceipts[0]?.id
    if (priorReceipts[0]?.outcome === 'SUCCEEDED') {
      throw new IntakeWebsiteResearchActionError(
        'CONFLICT',
        'Successful website research is terminal for this intake run.',
      )
    }
    if (
      (latestReceiptId && input.priorReceiptId !== latestReceiptId) ||
      (!latestReceiptId && input.priorReceiptId)
    ) {
      throw new IntakeWebsiteResearchActionError(
        'CONFLICT',
        'Research retry lineage is stale; reload the latest receipt before retrying.',
      )
    }

    if (input.outcome === 'SUCCEEDED') {
      for (const evidence of input.evidence) {
        const existing = await tx.intakeEvidenceRecord.findUnique({
          where: { id: evidence.id },
          select: {
            tenantId: true,
            venueId: true,
            runId: true,
            sourceKind: true,
            locator: true,
            normalizedHash: true,
            confidence: true,
            capturedAt: true,
          },
        })
        if (existing) {
          const exact =
            existing.tenantId === input.tenantId &&
            existing.venueId === input.venueId &&
            existing.runId === input.runId &&
            existing.sourceKind === 'WEBSITE' &&
            existing.locator === evidence.locator &&
            existing.normalizedHash === evidence.normalizedHash &&
            Number(existing.confidence) === evidence.confidence &&
            existing.capturedAt.toISOString() === evidence.capturedAt
          if (!exact) {
            throw new IntakeWebsiteResearchActionError(
              'CONFLICT',
              'Website evidence identity is already bound to different source evidence.',
            )
          }
        } else {
          await tx.intakeEvidenceRecord.create({
            data: {
              id: evidence.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
              runId: input.runId,
              sourceKind: 'WEBSITE',
              locator: evidence.locator,
              normalizedHash: evidence.normalizedHash,
              confidence: evidence.confidence,
              capturedAt: new Date(evidence.capturedAt),
            },
          })
        }
      }
    }

    const receipt = await tx.intakeWebsiteResearchReceipt.create({
      data: {
        id: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        ...(input.priorReceiptId ? { priorReceiptId: input.priorReceiptId } : {}),
        requestHash: input.requestHash,
        sourceUriHash: input.sourceUriHash,
        outcome: input.outcome,
        bounds: json(input.bounds),
        ...(input.researchSnapshot ? { researchSnapshot: json(input.researchSnapshot) } : {}),
        ...(input.candidateSnapshot !== undefined
          ? { candidateSnapshot: json(input.candidateSnapshot) }
          : {}),
        attemptedFetches: input.attemptedFetches,
        fetchedPages: input.fetchedPages,
        fetchedBytes: input.fetchedBytes,
        estimatedCostUnits: input.estimatedCostUnits,
        latencyMs: input.latencyMs,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        createdBy: input.createdBy,
      },
      select: { id: true, outcome: true, createdAt: true },
    })
    await tx.intakeRunEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        kind: 'WEBSITE_RESEARCH_RECORDED',
        actorId: input.createdBy,
        metadata: {
          receiptId: receipt.id,
          priorReceiptId: input.priorReceiptId ?? null,
          requestHash: input.requestHash,
          sourceUriHash: input.sourceUriHash,
          outcome: input.outcome,
          attemptedFetches: input.attemptedFetches,
          fetchedPages: input.fetchedPages,
          fetchedBytes: input.fetchedBytes,
          estimatedCostUnits: input.estimatedCostUnits,
          latencyMs: input.latencyMs,
          evidenceCount: input.evidence.length,
          discrepancyCount: input.discrepancies.length,
          errorCode: input.errorCode ?? null,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: 'PLATFORM_ADMIN',
        action: 'intake.website-research-recorded',
        targetType: 'IntakeWebsiteResearchReceipt',
        targetId: receipt.id,
        afterState: {
          runId: input.runId,
          priorReceiptId: input.priorReceiptId ?? null,
          requestHash: input.requestHash,
          sourceUriHash: input.sourceUriHash,
          outcome: input.outcome,
          attemptedFetches: input.attemptedFetches,
          fetchedPages: input.fetchedPages,
          fetchedBytes: input.fetchedBytes,
          estimatedCostUnits: input.estimatedCostUnits,
          latencyMs: input.latencyMs,
          evidenceCount: input.evidence.length,
          discrepancyCount: input.discrepancies.length,
          errorCode: input.errorCode ?? null,
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        },
      },
      tx,
    )
    return result(receipt, false)
  })
}
