import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { env } from '@pathfinder/config'
import {
  findTerminalJobRecordEvidenceById,
  writeAuditLogStrict,
  type TerminalJobRecordEvidence,
} from '@pathfinder/db'
import {
  inspectTerminalJobRedriveRuntime,
  TerminalRedriveRefusal,
  type TerminalRedrivePreview,
} from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const previewInput = z.object({ jobRecordId: z.string().trim().min(1).max(128) }).strict()

type Dependencies = {
  environment: string
  loadEvidence(id: string): Promise<TerminalJobRecordEvidence | null>
  inspect(params: { evidence: TerminalJobRecordEvidence }): Promise<TerminalRedrivePreview>
  audit: typeof writeAuditLogStrict
}

export async function previewTerminalJobRedrive(
  input: z.infer<typeof previewInput>,
  actorId: string,
  dependencies: Dependencies = {
    environment: env.RAILWAY_ENVIRONMENT,
    loadEvidence: findTerminalJobRecordEvidenceById,
    inspect: inspectTerminalJobRedriveRuntime,
    audit: writeAuditLogStrict,
  },
) {
  if (dependencies.environment !== 'staging') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Terminal redrive preview is available only in staging.',
    })
  }

  let evidence: TerminalJobRecordEvidence | null
  try {
    evidence = await dependencies.loadEvidence(input.jobRecordId)
  } catch {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Persisted recovery evidence could not be read.',
    })
  }
  if (!evidence) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Failed job evidence was not found.' })
  }

  let preview: TerminalRedrivePreview
  try {
    preview = await dependencies.inspect({ evidence })
  } catch (error) {
    if (error instanceof TerminalRedriveRefusal) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    }
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Live BullMQ recovery evidence could not be observed.',
    })
  }

  try {
    await dependencies.audit({
      tenantId: evidence.tenantId,
      actorId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'JOB_TERMINAL_REDRIVE_PREVIEWED',
      targetType: 'JobRecord',
      targetId: evidence.id,
      afterState: {
        queue: preview.queueName,
        jobName: preview.jobName,
        terminalAt: preview.terminalAt,
        attemptsMade: preview.attemptsMade,
        maxAttempts: preview.maxAttempts,
        payloadDigest: preview.payloadDigest,
        liveState: 'failed',
      },
    })
  } catch {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Recovery preview audit could not be persisted.',
    })
  }

  return {
    schemaVersion: 1,
    effect: 'READ_ONLY' as const,
    preview,
    boundaries: {
      environment: 'staging' as const,
      payloadIncluded: false,
      errorDetailIncluded: false,
      retryAuthorized: false,
      cancellationAuthorized: false,
      incidentControlAuthorized: false,
      executionSurface: 'SEPARATELY_GATED_AUDITED_CLI' as const,
    },
  }
}

export const adminTerminalRedrivePreviewRouter = router({
  previewTerminalJobRedrive: adminProcedure
    .input(previewInput)
    .query(({ ctx, input }) => previewTerminalJobRedrive(input, ctx.session.userId)),
})
