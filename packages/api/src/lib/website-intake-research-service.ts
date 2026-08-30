import { createHash } from 'node:crypto'

import {
  IntakeWebsiteResearchActionError,
  MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN,
  recordWebsiteResearchReceiptAction,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'
import {
  buildWebsiteIntakeProposal,
  WebsiteIntakePolicyError,
  type WebsiteIntakeDependencies,
} from './website-intake'

export type WebsiteResearchExecutionInput = {
  operationId: string
  priorReceiptId?: string
  tenantId: string
  venueId: string
  runId: string
  maxPages: number
  maxDepth: number
  maxBytesPerPage: number
  maxDurationMs: number
  maxCostUnits: number
  userAgent: string
  createdBy: string
}

export class WebsiteResearchExecutionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT' | 'LIMIT_REACHED',
    message: string,
  ) {
    super(message)
    this.name = 'WebsiteResearchExecutionError'
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function safeFailure(error: unknown): {
  outcome: 'INACCESSIBLE' | 'FAILED'
  errorCode: string
  errorMessage: string
} {
  if (error instanceof WebsiteIntakePolicyError) {
    const message = error.message
    if (/cancelled/iu.test(message)) {
      return {
        outcome: 'FAILED',
        errorCode: 'CANCELLED',
        errorMessage: 'Website research was cancelled before completion.',
      }
    }
    if (/time limit/iu.test(message)) {
      return {
        outcome: 'FAILED',
        errorCode: 'TIME_LIMIT',
        errorMessage: 'Website research exceeded its approved time limit.',
      }
    }
    if (/cost-unit/iu.test(message)) {
      return {
        outcome: 'FAILED',
        errorCode: 'COST_LIMIT',
        errorMessage: 'Website research exceeded its approved cost-unit limit.',
      }
    }
    if (/extractor/iu.test(message)) {
      return {
        outcome: 'FAILED',
        errorCode: 'EXTRACTION_FAILED',
        errorMessage: 'Website research could not extract reviewable page evidence.',
      }
    }
    if (
      /not allowed|did not resolve|non-public|HTTP (?:401|403|404|410)|robots|redirect/iu.test(
        message,
      )
    ) {
      return {
        outcome: 'INACCESSIBLE',
        errorCode: 'SOURCE_INACCESSIBLE',
        errorMessage: 'The website source was inaccessible under the approved crawl policy.',
      }
    }
    return {
      outcome: 'FAILED',
      errorCode: 'POLICY_FAILURE',
      errorMessage: 'Website research stopped at an approved policy boundary.',
    }
  }
  return {
    outcome: 'FAILED',
    errorCode: 'RUNTIME_FAILURE',
    errorMessage: 'Website research failed before a reviewable result was retained.',
  }
}

function safeReplay(receipt: { id: string; outcome: string; createdAt: Date }) {
  return {
    receiptId: receipt.id,
    outcome: receipt.outcome,
    createdAt: receipt.createdAt,
    replayed: true,
    evidenceRecorded: receipt.outcome === 'SUCCEEDED',
    packageDraftCreated: false as const,
    autoApproved: false as const,
    autoApplied: false as const,
    autoPublished: false as const,
  }
}

function mapActionError(error: unknown): never {
  if (error instanceof IntakeWebsiteResearchActionError) {
    throw new WebsiteResearchExecutionError(error.code, error.message)
  }
  throw error
}

export async function executeWebsiteIntakeResearch(input: {
  db: TRPCContext['db']
  request: WebsiteResearchExecutionInput
  dependencies: WebsiteIntakeDependencies
  now?: () => Date
}) {
  const clock = input.now ?? (() => new Date())
  const startedAt = clock()
  const run = await input.db.intakeRun.findFirst({
    where: {
      id: input.request.runId,
      tenantId: input.request.tenantId,
      venueId: input.request.venueId,
    },
    select: { id: true, sourceKind: true, websiteUri: true },
  })
  if (!run) throw new WebsiteResearchExecutionError('NOT_FOUND', 'Website intake run not found.')
  if (run.sourceKind !== 'WEBSITE' || !run.websiteUri) {
    throw new WebsiteResearchExecutionError(
      'INVALID_INPUT',
      'Only a website intake run can execute website research.',
    )
  }
  let source: URL
  try {
    source = new URL(run.websiteUri)
  } catch {
    throw new WebsiteResearchExecutionError('INVALID_INPUT', 'Stored website source is invalid.')
  }
  const bounds = {
    maxPages: input.request.maxPages,
    maxDepth: input.request.maxDepth,
    maxBytesPerPage: input.request.maxBytesPerPage,
    allowedHosts: [source.hostname],
    respectRobots: true as const,
    publishMode: 'DRAFT_ONLY' as const,
  }
  const sourceUriHash = hash(run.websiteUri)
  const requestHash = hash(
    stableJson({
      tenantId: input.request.tenantId,
      venueId: input.request.venueId,
      runId: input.request.runId,
      sourceUriHash,
      bounds,
      maxDurationMs: input.request.maxDurationMs,
      maxCostUnits: input.request.maxCostUnits,
      userAgent: input.request.userAgent,
    }),
  )
  const existing = await input.db.intakeWebsiteResearchReceipt.findUnique({
    where: {
      id: input.request.operationId,
      tenantId: input.request.tenantId,
      venueId: input.request.venueId,
      runId: input.request.runId,
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      runId: true,
      priorReceiptId: true,
      requestHash: true,
      sourceUriHash: true,
      createdBy: true,
      outcome: true,
      createdAt: true,
    },
  })
  if (existing) {
    if (
      existing.tenantId !== input.request.tenantId ||
      existing.venueId !== input.request.venueId ||
      existing.runId !== input.request.runId ||
      existing.priorReceiptId !== (input.request.priorReceiptId ?? null) ||
      existing.requestHash !== requestHash ||
      existing.sourceUriHash !== sourceUriHash ||
      existing.createdBy !== input.request.createdBy
    ) {
      throw new WebsiteResearchExecutionError(
        'CONFLICT',
        'The operation ID is already bound to different website research.',
      )
    }
    return safeReplay(existing)
  }
  const prior = await input.db.intakeWebsiteResearchReceipt.findMany({
    where: {
      tenantId: input.request.tenantId,
      venueId: input.request.venueId,
      runId: input.request.runId,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN,
    select: { id: true, outcome: true },
  })
  if (prior.length >= MAX_WEBSITE_RESEARCH_RECEIPTS_PER_RUN) {
    throw new WebsiteResearchExecutionError(
      'LIMIT_REACHED',
      'This website intake run has reached its bounded research attempt limit.',
    )
  }
  if (prior[0]?.outcome === 'SUCCEEDED') {
    throw new WebsiteResearchExecutionError(
      'CONFLICT',
      'Successful website research is terminal for this intake run.',
    )
  }
  if (
    (prior[0] && prior[0].id !== input.request.priorReceiptId) ||
    (!prior[0] && input.request.priorReceiptId)
  ) {
    throw new WebsiteResearchExecutionError(
      'CONFLICT',
      'Research retry lineage is stale; reload the latest receipt before retrying.',
    )
  }

  let attemptedFetches = 0
  let fetchedPages = 0
  let fetchedBytes = 0
  const meteredDependencies: WebsiteIntakeDependencies = {
    ...input.dependencies,
    fetchPage: async (request) => {
      attemptedFetches += 1
      const response = await input.dependencies.fetchPage(request)
      if (response.status >= 200 && response.status < 300) {
        fetchedBytes +=
          typeof response.body === 'string'
            ? Buffer.byteLength(response.body, 'utf8')
            : response.body.byteLength
      }
      return response
    },
    extractPage: async (page) => {
      const extracted = await input.dependencies.extractPage(page)
      fetchedPages += 1
      const units = fetchedPages + Math.ceil(fetchedBytes / 100_000)
      if (units > input.request.maxCostUnits) {
        throw new WebsiteIntakePolicyError('Website intake exceeded its cost-unit limit')
      }
      return extracted
    },
  }

  try {
    const website = await buildWebsiteIntakeProposal(
      {
        tenantId: input.request.tenantId,
        venueId: input.request.venueId,
        sourceId: input.request.runId,
        startUrl: run.websiteUri,
        bounds,
        userAgent: input.request.userAgent,
        maxDurationMs: input.request.maxDurationMs,
      },
      meteredDependencies,
    )
    if (website.intermediate.pages.length === 0) {
      return await recordWebsiteResearchReceiptAction(
        {
          operationId: input.request.operationId,
          ...(input.request.priorReceiptId ? { priorReceiptId: input.request.priorReceiptId } : {}),
          tenantId: input.request.tenantId,
          venueId: input.request.venueId,
          runId: input.request.runId,
          requestHash,
          sourceUriHash,
          bounds,
          outcome: 'INACCESSIBLE',
          evidence: [],
          discrepancies: [],
          attemptedFetches,
          fetchedPages: 0,
          fetchedBytes,
          estimatedCostUnits: Math.ceil(fetchedBytes / 100_000),
          latencyMs: Math.max(0, clock().getTime() - startedAt.getTime()),
          errorCode: 'NO_ACCESSIBLE_PAGES',
          errorMessage: 'No website page was accessible within the approved crawl policy.',
          createdBy: input.request.createdBy,
        },
        input.db,
      )
    }
    return await recordWebsiteResearchReceiptAction(
      {
        operationId: input.request.operationId,
        ...(input.request.priorReceiptId ? { priorReceiptId: input.request.priorReceiptId } : {}),
        tenantId: input.request.tenantId,
        venueId: input.request.venueId,
        runId: input.request.runId,
        requestHash,
        sourceUriHash,
        bounds,
        outcome: 'SUCCEEDED',
        researchSnapshot: website.intermediate,
        candidateSnapshot: website.packageBinding,
        evidence: [...website.intermediate.evidence],
        discrepancies: [...website.intermediate.discrepancies],
        attemptedFetches: website.job.attemptedFetches,
        fetchedPages: website.job.fetchedPages,
        fetchedBytes: website.job.fetchedBytes,
        estimatedCostUnits: website.job.estimatedCostUnits,
        latencyMs: Math.max(0, clock().getTime() - startedAt.getTime()),
        createdBy: input.request.createdBy,
      },
      input.db,
    )
  } catch (error) {
    if (
      error instanceof IntakeWebsiteResearchActionError ||
      error instanceof WebsiteResearchExecutionError
    ) {
      mapActionError(error)
    }
    const failure = safeFailure(error)
    try {
      return await recordWebsiteResearchReceiptAction(
        {
          operationId: input.request.operationId,
          ...(input.request.priorReceiptId ? { priorReceiptId: input.request.priorReceiptId } : {}),
          tenantId: input.request.tenantId,
          venueId: input.request.venueId,
          runId: input.request.runId,
          requestHash,
          sourceUriHash,
          bounds,
          outcome: failure.outcome,
          evidence: [],
          discrepancies: [],
          attemptedFetches,
          fetchedPages,
          fetchedBytes,
          estimatedCostUnits: fetchedPages + Math.ceil(fetchedBytes / 100_000),
          latencyMs: Math.max(0, clock().getTime() - startedAt.getTime()),
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
          createdBy: input.request.createdBy,
        },
        input.db,
      )
    } catch (recordError) {
      mapActionError(recordError)
    }
  }
}
