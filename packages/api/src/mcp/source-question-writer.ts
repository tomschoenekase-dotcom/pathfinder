import { askAgentQuestionActionInTransaction, assertCurrentAgentWorkerClaim } from '@pathfinder/db'
import type { AgentQuestionClient } from '@pathfinder/db'
import {
  McpSourceClarification,
  type VerifiedMcpCredentialScope,
} from '@pathfinder/contracts/mcp-v0'

import { fileExtractionClarificationQuestionPayload } from '../lib/intake-file-clarifications'
import type { VerifiedMcpInvocationContext } from './registry'

type SourceQuestionDb = Pick<AgentQuestionClient, '$transaction'>

export type SourceClarificationInput = Readonly<ReturnType<typeof McpSourceClarification.parse>>

export type SourceQuestionWriterServices = Readonly<{
  assertCurrentAgentWorkerClaim?: typeof assertCurrentAgentWorkerClaim
  askAgentQuestionActionInTransaction?: typeof askAgentQuestionActionInTransaction
}>

export class SourceQuestionWriterError extends Error {
  readonly code = 'SOURCE_QUESTION_UNAVAILABLE'

  constructor() {
    super('The requested source clarification is unavailable.')
    this.name = 'SourceQuestionWriterError'
  }
}

function assertSourceScope(
  credential: VerifiedMcpCredentialScope,
  tenantId: string,
  venueId: string,
) {
  const required = ['questions:ask', 'intake-source:read', 'agent-runs:execute']
  if (
    credential.tenantId !== tenantId ||
    credential.clientId !== tenantId ||
    credential.venueIds.length !== 1 ||
    credential.venueIds[0] !== venueId ||
    !required.every((capability) => credential.capabilities.includes(capability as never))
  )
    throw new SourceQuestionWriterError()
}

function claimInput(
  context: VerifiedMcpInvocationContext,
  agentRunId: string,
  actionClass: 'OPERATOR_QUESTION',
) {
  const claim = context.executionClaim
  if (!claim || claim.agentRunId !== agentRunId) throw new SourceQuestionWriterError()
  return {
    tenantId: context.credential.tenantId,
    clientId: context.credential.clientId,
    venueId: context.credential.venueIds[0]!,
    agentRunId,
    executionLeaseToken: claim.executionLeaseToken,
    bridgeSessionId: claim.bridgeSessionId,
    workerId: claim.workerId,
    credentialScope: context.credential,
    requiredAgentType: 'CONTENT' as const,
    requiredIdentityCapability: 'intake.read' as const,
    requiredTransportCapabilities: ['questions:ask', 'intake-source:read'] as Array<
      'questions:ask' | 'intake-source:read'
    >,
    actionClass,
  }
}

/**
 * Writes one exact file-extraction question from a currently claimed Content worker.  Every
 * authority and receipt check occurs in the same transaction as the canonical question action.
 */
export async function writeSourceClarificationQuestion(
  db: SourceQuestionDb,
  input: {
    clientId: string
    venueId: string
    agentRunId: string
    agentIdentityId: string
    question: string
    sourceClarification: SourceClarificationInput
  },
  context: VerifiedMcpInvocationContext,
  services: SourceQuestionWriterServices = {},
) {
  if (
    input.clientId !== context.credential.clientId ||
    !input.venueId ||
    !input.agentRunId ||
    !input.agentIdentityId ||
    !input.question.trim()
  )
    throw new SourceQuestionWriterError()
  const parsedSource = McpSourceClarification.safeParse(input.sourceClarification)
  if (!parsedSource.success) throw new SourceQuestionWriterError()
  assertSourceScope(context.credential, context.credential.tenantId, input.venueId)

  const admit = services.assertCurrentAgentWorkerClaim ?? assertCurrentAgentWorkerClaim
  const askInTransaction =
    services.askAgentQuestionActionInTransaction ?? askAgentQuestionActionInTransaction
  const source = parsedSource.data
  const tenantId = context.credential.tenantId

  try {
    return await db.$transaction(async (tx) => {
      const payload = fileExtractionClarificationQuestionPayload({
        tenantId,
        venueId: input.venueId,
        runId: source.runId,
        receiptId: source.receiptId,
        extractedTextHash: source.expectedExtractedTextHash,
        fieldPath: source.fieldPath,
        reason: source.reason,
        blockerScope: source.blockerScope,
        question: input.question,
        evidenceExcerpt: source.evidenceExcerpt,
        agentIdentityId: input.agentIdentityId,
        agentRunId: input.agentRunId,
      })
      return askInTransaction(tx as never, payload, {
        admitQuestion: async (lockedTx) => {
          const admitted = await admit(
            lockedTx as never,
            claimInput(context, input.agentRunId, 'OPERATOR_QUESTION'),
          )
          if (admitted.agentIdentityId !== input.agentIdentityId)
            throw new SourceQuestionWriterError()
          // assertCurrentAgentWorkerClaim already holds the exact identity row FOR SHARE. This
          // effect-time predicate adds the separate draft authority without conflating it with the
          // source-read identity capability.
          const identity = await lockedTx.agentIdentity.findFirst({
            where: {
              id: admitted.agentIdentityId,
              tenantId,
              enabled: true,
              agentType: 'CONTENT',
              accessCapabilities: { has: 'content.draft' },
              OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
            },
            select: { id: true },
          })
          if (!identity) throw new SourceQuestionWriterError()
          const exactReceipt = await lockedTx.intakeFileExtractionReceipt.findFirst({
            where: {
              id: source.receiptId,
              tenantId,
              venueId: input.venueId,
              runId: source.runId,
              outcome: 'SUCCEEDED',
              extractedTextHash: source.expectedExtractedTextHash,
              review: { is: null },
              run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
            },
            select: { extractedText: true },
          })
          if (!exactReceipt?.extractedText?.includes(source.evidenceExcerpt))
            throw new SourceQuestionWriterError()
        },
      })
    })
  } catch (error) {
    if (error instanceof SourceQuestionWriterError) throw error
    throw new SourceQuestionWriterError()
  }
}
