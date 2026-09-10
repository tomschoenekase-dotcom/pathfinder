import { z } from 'zod'

/** Lookup keys supplied by a worker; authority is checked against locked current DB rows. */
export const McpExecutionClaim = z
  .object({
    agentRunId: z.string().trim().min(1).max(191),
    bridgeSessionId: z.string().uuid(),
    workerId: z.string().trim().min(1).max(191),
    executionLeaseToken: z.string().uuid(),
  })
  .strict()

export type McpExecutionClaim = z.infer<typeof McpExecutionClaim>
