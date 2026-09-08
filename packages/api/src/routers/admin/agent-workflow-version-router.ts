import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AgentWorkflowPortableManifestSchema,
  AgentWorkflowProvenanceSchema,
} from '@pathfinder/contracts/agent-workflow-registry'
import {
  AgentWorkflowRegistryError,
  db,
  readCompatibleAgentWorkflowVersions,
  registerAgentWorkflowVersion,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { currentCallableCapabilities } from './agent-workflow-capabilities'

function translateRegistryError(error: unknown): never {
  if (error instanceof AgentWorkflowRegistryError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  }

  throw error
}

export const adminAgentWorkflowVersionsRouter = router({
  registerAgentWorkflowVersion: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          manifest: AgentWorkflowPortableManifestSchema,
          portableText: z.string().trim().min(1).max(50_000),
          provenance: AgentWorkflowProvenanceSchema,
          supersedesVersionId: z.string().uuid().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await registerAgentWorkflowVersion(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            currentCallableCapabilities(),
            db,
          )
        } catch (error) {
          return translateRegistryError(error)
        }
      }),
    ),

  listCompatibleAgentWorkflowVersions: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          registryKeys: z.array(z.string().min(1).max(191)).min(1).max(50),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        readCompatibleAgentWorkflowVersions(input, currentCallableCapabilities(), db),
      ),
    ),
})
