import { z } from 'zod'

const actorId = z.string().trim().min(1).max(191)
const optionalLineageId = z.string().trim().min(1).max(191).optional()

const actorEvidence = z
  .object({
    capability: z.string().trim().min(1).max(191).optional(),
    approvalGrantId: optionalLineageId,
    credentialId: optionalLineageId,
    agentIdentityId: optionalLineageId,
    agentRunId: optionalLineageId,
    workerId: optionalLineageId,
    systemJobId: optionalLineageId,
    integrationId: optionalLineageId,
    modelProvider: z.string().trim().min(1).max(100).optional(),
    modelName: z.string().trim().min(1).max(191).optional(),
    idempotencyKey: z.string().trim().min(1).max(191).optional(),
  })
  .strict()

export const HumanActorContext = actorEvidence.extend({
  type: z.literal('HUMAN'),
  actorId,
  role: z.string().trim().min(1).max(64),
})

export const MachineActorContext = actorEvidence.extend({
  type: z.literal('AGENT'),
  actorId,
  role: z.literal('AGENT'),
  agentIdentityId: actorId,
  agentRunId: actorId,
  workerId: actorId,
  credentialId: actorId,
  capability: z.string().trim().min(1).max(191),
})

export const SystemActorContext = actorEvidence.extend({
  type: z.literal('SYSTEM'),
  actorId,
  role: z.literal('SYSTEM'),
  systemJobId: actorId,
})

export const IntegrationActorContext = actorEvidence.extend({
  type: z.literal('INTEGRATION'),
  actorId,
  role: z.literal('INTEGRATION'),
  integrationId: actorId,
})

export const VerifiedActorContext = z.discriminatedUnion('type', [
  HumanActorContext,
  MachineActorContext,
  SystemActorContext,
  IntegrationActorContext,
])

export type HumanActorContext = z.infer<typeof HumanActorContext>
export type MachineActorContext = z.infer<typeof MachineActorContext>
export type SystemActorContext = z.infer<typeof SystemActorContext>
export type IntegrationActorContext = z.infer<typeof IntegrationActorContext>
export type VerifiedActorContext = z.infer<typeof VerifiedActorContext>

export function parseVerifiedActorContext(input: unknown): VerifiedActorContext {
  const actor = VerifiedActorContext.parse(input)
  if (
    actor.type === 'AGENT' &&
    (actor.modelProvider === undefined) !== (actor.modelName === undefined)
  ) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['modelProvider'],
        message: 'Machine actor model provider and model name must be supplied together',
      },
    ])
  }
  return actor
}
