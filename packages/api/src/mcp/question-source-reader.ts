import type { PrismaClient } from '@prisma/client'

import { assertMcpScope, type McpReadInput, type McpToolResult } from '@pathfinder/contracts/mcp-v0'
import { assertCurrentAgentWorkerClaim } from '@pathfinder/db'

import { readIntakeFileExtractionSource } from '../lib/intake-file-extraction-reader'
import type { VerifiedMcpInvocationContext } from './registry'

export type QuestionSourceReaderDb = Pick<PrismaClient, '$transaction' | 'agentQuestion'>

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

function sameLocator(left: SourceLocator, right: SourceLocator) {
  return (
    left.runId === right.runId &&
    left.receiptId === right.receiptId &&
    left.extractedTextHash === right.extractedTextHash &&
    left.agentRunId === right.agentRunId
  )
}

/**
 * Reads a retained extraction page only through an exact persisted source question and a current
 * authenticated worker claim. Caller-provided IDs select rows; the locked transaction admits them.
 */
export async function readQuestionBoundSource(
  db: QuestionSourceReaderDb,
  input: McpReadInput,
  context: VerifiedMcpInvocationContext,
  services: QuestionSourceReaderServices = {},
): Promise<McpToolResult> {
  const executionClaim = context.executionClaim
  if (
    input.resource !== 'question-source' ||
    !input.agentRunId ||
    !input.questionId ||
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

  const firstQuestion = await db.agentQuestion.findFirst({
    where: {
      id: questionId,
      tenantId: context.credential.tenantId,
      venueId,
      agentRunId,
    },
    select: { callbackMetadata: true },
  })
  const initialLocator = locator(firstQuestion?.callbackMetadata)
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

      const question = await tx.agentQuestion.findFirst({
        where: {
          id: questionId,
          tenantId: context.credential.tenantId,
          venueId,
          agentRunId,
          agentIdentityId: admitted.agentIdentityId,
        },
        select: { callbackMetadata: true },
      })
      const lockedLocator = locator(question?.callbackMetadata)
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
        kind: 'pathfinder.question-source',
        summary: 'Authorized question source page read completed.',
        data: {
          questionId,
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
