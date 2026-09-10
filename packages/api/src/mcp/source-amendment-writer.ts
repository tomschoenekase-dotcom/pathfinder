import { assertCurrentAgentWorkerClaim, writeAuditLogStrict } from '@pathfinder/db'
import { McpResolveSourceClarificationInput } from '@pathfinder/contracts/mcp-v0'
import { resolveFileExtractionClarificationInTransaction } from '../lib/intake-file-clarifications'
import type { FileClarificationResolutionTransaction } from '../lib/intake-file-clarifications'
import type { VerifiedMcpInvocationContext } from './registry'

type SourceAmendmentDb = {
  $transaction<T>(callback: (tx: FileClarificationResolutionTransaction) => Promise<T>): Promise<T>
}
export class SourceAmendmentWriterError extends Error {
  readonly code = 'SOURCE_AMENDMENT_UNAVAILABLE'
  constructor() {
    super('The requested source amendment is unavailable.')
    this.name = 'SourceAmendmentWriterError'
  }
}

/** Retains review evidence only. The source receipt lock encloses admission, replay and audit. */
export async function writeSourceClarificationAmendment(
  db: SourceAmendmentDb,
  raw: unknown,
  context: VerifiedMcpInvocationContext,
  services: {
    assertCurrentAgentWorkerClaim?: typeof assertCurrentAgentWorkerClaim
    resolveFileExtractionClarificationInTransaction?: typeof resolveFileExtractionClarificationInTransaction
    writeAuditLogStrict?: typeof writeAuditLogStrict
  } = {},
) {
  const parsed = McpResolveSourceClarificationInput.safeParse(raw)
  if (!parsed.success) throw new SourceAmendmentWriterError()
  const input = parsed.data
  const credential = context.credential
  const claim = context.executionClaim
  const grants = ['intake:draft', 'intake-source:read', 'agent-runs:execute'] as const
  if (
    !claim ||
    claim.agentRunId !== input.agentRunId ||
    credential.tenantId !== input.clientId ||
    credential.clientId !== input.clientId ||
    credential.venueIds.length !== 1 ||
    credential.venueIds[0] !== input.venueId ||
    !grants.every((grant) => credential.capabilities.includes(grant))
  )
    throw new SourceAmendmentWriterError()
  const admit = services.assertCurrentAgentWorkerClaim ?? assertCurrentAgentWorkerClaim
  const resolve =
    services.resolveFileExtractionClarificationInTransaction ??
    resolveFileExtractionClarificationInTransaction
  const audit = services.writeAuditLogStrict ?? writeAuditLogStrict
  try {
    return await db.$transaction(async (tx) => {
      const result = await resolve(
        tx,
        {
          tenantId: credential.tenantId,
          venueId: input.venueId!,
          runId: input.runId,
          receiptId: input.receiptId,
          requestId: input.requestId,
          expectedExtractedTextHash: input.expectedExtractedTextHash,
          questionId: input.questionId,
          expectedAnsweredAt: new Date(input.expectedAnsweredAt),
          kind: input.kind,
          ...(input.amendedExcerpt === undefined ? {} : { amendedExcerpt: input.amendedExcerpt }),
          rationale: input.rationale,
          actorId: input.agentIdentityId,
        },
        {
          admitResolution: async (lockedTx) => {
            // Immutable bindings are installed before queueing. This new effect does not lift
            // selected-workflow activation holds or borrow another effect's approval semantics.
            const binding = await lockedTx.agentWorkflowRunBinding.findFirst({
              where: {
                tenantId: credential.tenantId,
                venueId: input.venueId!,
                agentRunId: input.agentRunId,
                outcome: { in: ['SELECTED', 'CANARY_SKIPPED_PRIOR_VERSION'] },
              },
              select: { id: true },
            })
            if (binding) throw new SourceAmendmentWriterError()
            const admitted = await admit(lockedTx as never, {
              tenantId: credential.tenantId,
              clientId: credential.clientId,
              venueId: input.venueId!,
              ...claim,
              credentialScope: credential,
              requiredAgentType: 'CONTENT',
              requiredIdentityCapability: 'intake.read',
              requiredTransportCapabilities: [...grants],
            })
            if (admitted.agentIdentityId !== input.agentIdentityId)
              throw new SourceAmendmentWriterError()
            const identity = await lockedTx.agentIdentity.findFirst({
              where: {
                id: admitted.agentIdentityId,
                tenantId: credential.tenantId,
                enabled: true,
                agentType: 'CONTENT',
                accessCapabilities: { has: 'content.draft' },
                OR: [{ venueId: input.venueId! }, { venueId: null, accessScope: 'CLIENT' }],
              },
              select: { id: true },
            })
            const question = await lockedTx.agentQuestion.findFirst({
              where: {
                id: input.questionId,
                tenantId: credential.tenantId,
                venueId: input.venueId!,
                agentRunId: input.agentRunId,
                agentIdentityId: admitted.agentIdentityId,
                category: 'builder-file-clarification',
                status: 'ANSWERED',
                answeredAt: new Date(input.expectedAnsweredAt),
              },
              select: { id: true },
            })
            const receipt = await lockedTx.intakeFileExtractionReceipt.findFirst({
              where: {
                id: input.receiptId,
                tenantId: credential.tenantId,
                venueId: input.venueId!,
                runId: input.runId,
                outcome: 'SUCCEEDED',
                extractedTextHash: input.expectedExtractedTextHash,
                review: { is: null },
                run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
              },
              select: { id: true },
            })
            if (!identity || !question || !receipt) throw new SourceAmendmentWriterError()
          },
        },
      )
      if (!result.replayed)
        await audit(
          {
            tenantId: credential.tenantId,
            actor: {
              type: 'AGENT',
              role: 'AGENT',
              actorId: input.agentIdentityId,
              agentIdentityId: input.agentIdentityId,
              agentRunId: input.agentRunId,
              workerId: claim.workerId,
              credentialId: credential.credentialId,
              capability: 'intake:draft',
              idempotencyKey: input.requestId,
            },
            action: 'intake-file-clarification.agent-amendment-recorded',
            targetType: 'IntakeFileClarificationResolution',
            targetId: result.resolutionId,
            afterState: {
              questionId: input.questionId,
              receiptId: input.receiptId,
              kind: input.kind,
              terminalReviewRequired: true,
            },
          },
          tx as never,
        )
      return result
    })
  } catch {
    throw new SourceAmendmentWriterError()
  }
}
