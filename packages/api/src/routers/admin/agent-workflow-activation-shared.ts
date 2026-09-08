import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  AgentWorkflowActivationError,
  AgentWorkflowPromotionAssessmentError,
  assertVenueAvailable,
  db,
  isVenueUnavailableError,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { createSafeOperationalMcpRegistry } from '../../mcp/composition'

export const scope = z
  .object({ tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) })
  .strict()

export const common = {
  operationId: z.string().uuid(),
  registryKey: z.string().min(1).max(191),
  expectedHeadRevision: z.number().int().min(0),
  reason: z.string().trim().min(1).max(2000),
}

export const capabilities = () =>
  new Set(
    createSafeOperationalMcpRegistry()
      .listTools()
      .map((tool) => tool._meta['com.pathfinder/security'].capability),
  )

const mapped = (error: unknown): never => {
  if (error instanceof TRPCError) throw error
  if (error instanceof AgentWorkflowActivationError) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  }
  if (error instanceof AgentWorkflowPromotionAssessmentError) {
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
  if (error instanceof z.ZodError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid workflow transition input' })
  if (isVenueUnavailableError(error))
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue is unavailable' })
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Workflow activation could not be completed',
  })
}

export const authorized = async <T>(
  input: { tenantId: string; venueId: string },
  fn: () => Promise<T>,
) => {
  try {
    await assertVenueAvailable(db, input)
    return await withTenantIsolationBypass(() => fn())
  } catch (error) {
    return mapped(error)
  }
}
