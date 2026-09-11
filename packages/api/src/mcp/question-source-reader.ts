import type { PrismaClient } from '@prisma/client'

import { assertMcpScope, type McpReadInput, type McpToolResult } from '@pathfinder/contracts/mcp-v0'
import { readAgentSourceAssignment } from '@pathfinder/contracts'
import { assertCurrentAgentWorkerClaim } from '@pathfinder/db'

import { readIntakeFileExtractionSource } from '../lib/intake-file-extraction-reader'
import type { VerifiedMcpInvocationContext } from './registry'

export type QuestionSourceReaderDb = Pick<
  PrismaClient,
  '$transaction' | 'agentQuestion' | 'agentRun'
>

export type QuestionSourceReaderServices = Readonly<{
  assertCurrentAgentWorkerClaim?: typeof assertCurrentAgentWorkerClaim
  readIntakeFileExtractionSource?: typeof readIntakeFileExtractionSource
}>

type SourceLocator = Readonly<{
  runId: string
  receiptId: string
  extractedTextHash: string
  agentRunId: string
}>

export class QuestionSourceReaderError extends Error {
  readonly code = 'RESOURCE_UNAVAILABLE'

  constructor() {
    super('The requested question source is unavailable.')
    this.name = 'QuestionSourceReaderError'
  }
}

function locator(value: unknown): SourceLocator | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const metadata = value as Record<string, unknown>
  if (
    metadata.workflow !== 'intake-file-extraction-clarification' ||
    typeof metadata.runId !== 'string' ||
    metadata.runId.length < 1 ||
    metadata.runId.length > 191 ||
    typeof metadata.receiptId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      metadata.receiptId,
    ) ||
    typeof metadata.extractedTextHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(metadata.extractedTextHash) ||
    typeof metadata.agentRunId !== 'string' ||
    metadata.agentRunId.length < 1 ||
    metadata.agentRunId.length > 191
  )
    return null
  return {
    runId: metadata.runId,
    receiptId: metadata.receiptId,
    extractedTextHash: metadata.extractedTextHash,
    agentRunId: metadata.agentRunId,
  }
}

function assignmentLocator(snapshot: unknown, agentRunId: string): SourceLocator | null {
  const assignment = readAgentSourceAssignment(snapshot)
  return assignment
    ? {
        runId: assignment.intakeRunId,
        receiptId: assignment.receiptId,
        extractedTextHash: assignment.extractedTextHash,
        agentRunId,
      }
    : null
}

function sameLocator(left: SourceLocator, right: SourceLocator) {
  return (
    left.runId === right.runId &&
    left.receiptId === right.receiptId &&
    left.extractedTextHash === right.extractedTextHash &&
    left.agentRunId === right.agentRunId
  )
}

/**
 * Reads a retained extraction page only through an exact persisted source question or task assignment and a current
 * authenticated worker claim. Caller-provided IDs select rows; the locked transaction admits them.
 */
export async function readWorkerBoundSource(
  db: QuestionSourceReaderDb,
  input: McpReadInput,
  context: VerifiedMcpInvocationContext,
  services: QuestionSourceReaderServices = {},
): Promise<McpToolResult> {
  const executionClaim = context.executionClaim
  if (
    !['question-source', 'assigned-source'].includes(input.resource) ||
    !input.agentRunId ||
    (input.resource === 'question-source' ? !input.questionId : input.questionId !== undefined) ||
    !input.venueId ||
    !executionClaim ||
    executionClaim.agentRunId !== input.agentRunId ||
    context.credential.tenantId !== context.credential.clientId ||
    input.clientId !== context.credential.clientId
  )
    throw new QuestionSourceReaderError()
  try {
    assertMcpScope(context.credential, input, 'resources:read', 'venue')
    assertMcpScope(context.credential, input, 'intake-source:read', 'venue')
  } catch {
    throw new QuestionSourceReaderError()
  }
  const agentRunId = input.agentRunId
  const questionId = input.questionId
  const venueId = input.venueId

  const initialLocator =
    input.resource === 'assigned-source'
      ? assignmentLocator(
          (
            await db.agentRun.findFirst({
              where: { id: agentRunId, tenantId: context.credential.tenantId, venueId },
              select: { scopeSnapshot: true },
            })
          )?.scopeSnapshot,
          agentRunId,
        )
      : locator(
          (
            await db.agentQuestion.findFirst({
              where: {
                id: questionId!,
                tenantId: context.credential.tenantId,
                venueId,
                agentRunId,
              },
              select: { callbackMetadata: true },
            })
          )?.callbackMetadata,
        )
  if (!initialLocator || initialLocator.agentRunId !== agentRunId)
    throw new QuestionSourceReaderError()

  const admitClaim = services.assertCurrentAgentWorkerClaim ?? assertCurrentAgentWorkerClaim
  const readSource = services.readIntakeFileExtractionSource ?? readIntakeFileExtractionSource

  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${context.credential.tenantId}:${venueId}:${initialLocator.receiptId}`}, 0))`

      const admitted = await admitClaim(tx as never, {
        tenantId: context.credential.tenantId,
        clientId: context.credential.clientId,
        venueId,
        agentRunId,
        executionLeaseToken: executionClaim.executionLeaseToken,
        bridgeSessionId: executionClaim.bridgeSessionId,
        workerId: executionClaim.workerId,
        credentialScope: context.credential,
        requiredAgentType: 'CONTENT',
        requiredIdentityCapability: 'intake.read',
        requiredTransportCapabilities: ['resources:read', 'intake-source:read'],
      })

      const lockedLocator =
        input.resource === 'assigned-source'
          ? assignmentLocator(
              (
                await tx.agentRun.findFirst({
                  where: {
                    id: agentRunId,
                    tenantId: context.credential.tenantId,
                    venueId,
                    agentIdentityId: admitted.agentIdentityId,
                  },
                  select: { scopeSnapshot: true },
                })
              )?.scopeSnapshot,
              agentRunId,
            )
          : locator(
              (
                await tx.agentQuestion.findFirst({
                  where: {
                    id: questionId!,
                    tenantId: context.credential.tenantId,
                    venueId,
                    agentRunId,
                    agentIdentityId: admitted.agentIdentityId,
                  },
                  select: { callbackMetadata: true },
                })
              )?.callbackMetadata,
            )
      if (
        !lockedLocator ||
        lockedLocator.agentRunId !== agentRunId ||
        !sameLocator(initialLocator, lockedLocator)
      )
        throw new QuestionSourceReaderError()

      const receipt = await tx.intakeFileExtractionReceipt.findFirst({
        where: {
          id: lockedLocator.receiptId,
          tenantId: context.credential.tenantId,
          venueId,
          runId: lockedLocator.runId,
          outcome: 'SUCCEEDED',
          extractedTextHash: lockedLocator.extractedTextHash,
          review: { is: null },
        },
        select: { id: true },
      })
      if (!receipt) throw new QuestionSourceReaderError()

      const page = await readSource(
        {
          tenantId: context.credential.tenantId,
          venueId,
          runId: lockedLocator.runId,
          receiptId: lockedLocator.receiptId,
          expectedExtractedTextHash: lockedLocator.extractedTextHash,
          ...(input.sourceCursor ? { cursor: input.sourceCursor } : {}),
          ...(input.pageSize ? { pageSize: input.pageSize } : {}),
          ...(input.search ? { search: input.search } : {}),
        },
        tx as never,
      )

      return {
        kind:
          input.resource === 'assigned-source'
            ? 'pathfinder.assigned-source'
            : 'pathfinder.question-source',
        summary: 'Authorized worker source page read completed.',
        data: {
          ...(questionId ? { questionId } : {}),
          agentRunId,
          extractedTextHash: page.extractedTextHash,
          extractedCharacterCount: page.extractedCharacterCount,
          extractedLineCount: page.extractedLineCount,
          page: page.page,
          nextSourceCursor: page.nextCursor,
        } as McpToolResult['data'],
      }
    })
  } catch (error) {
    if (error instanceof QuestionSourceReaderError) throw error
    throw new QuestionSourceReaderError()
  }
}

// Retain the existing export for question-reader callers.
export const readQuestionBoundSource = readWorkerBoundSource
