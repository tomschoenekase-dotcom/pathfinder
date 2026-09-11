import { z } from 'zod'

/** Exact immutable task input, not permission to read or publish its source. */
export const AgentSourceAssignment = z
  .object({
    version: z.literal(1),
    kind: z.literal('FILE_EXTRACTION'),
    intakeRunId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    extractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
export type AgentSourceAssignment = z.infer<typeof AgentSourceAssignment>

export function readAgentSourceAssignment(snapshot: unknown): AgentSourceAssignment | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const parsed = AgentSourceAssignment.safeParse(
    (snapshot as Record<string, unknown>).sourceAssignment,
  )
  return parsed.success ? parsed.data : null
}

/** Minimum dispatch requirements; effect-time checks remain mandatory. */
export const AGENT_SOURCE_WORKER_ROLES = ['CONTENT'] as const
export const AGENT_SOURCE_WORKER_CAPABILITIES = [
  'agent-runs:execute',
  'intake-source:read',
  'resources:read',
] as const
