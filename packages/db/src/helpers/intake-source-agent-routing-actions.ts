import { z } from 'zod'
import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const IntakeSourceAgentRoutingInput = z
  .object({
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    agentIdentityId: z.string().trim().min(1).max(191),
    expectedRevision: z.number().int().min(0),
    enabled: z.boolean().default(false),
  })
  .strict()
export class IntakeSourceAgentRoutingError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeSourceAgentRoutingError'
  }
}

/** Human configuration intent only; this action never creates or dispatches a task. */
export async function configureIntakeSourceAgentRouting(
  raw: z.input<typeof IntakeSourceAgentRoutingInput>,
  actorId: string,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const input = IntakeSourceAgentRoutingInput.parse(raw)
  const actor = z.string().trim().min(1).max(191).parse(actorId)
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-source-routing:${input.tenantId}:${input.venueId}`}, 0))`
    const current = await tx.intakeSourceAgentRoutingPolicy.findUnique({
      where: {
        tenantId: input.tenantId,
        tenantId_venueId: { tenantId: input.tenantId, venueId: input.venueId },
      },
    })
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new IntakeSourceAgentRoutingError(
        'CONFLICT',
        'Source routing changed; reload its exact revision.',
      )
    // Preserve a coherent identity decision while the policy is written. Dispatcher will
    // independently revalidate current identity and source authority before task creation.
    await tx.$queryRaw`SELECT id FROM agent_identities WHERE id = ${input.agentIdentityId} AND tenant_id = ${input.tenantId} FOR SHARE`
    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: input.agentIdentityId,
        tenantId: input.tenantId,
        agentType: 'CONTENT',
        OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
      },
      select: {
        enabled: true,
        accessCapabilities: true,
        autonomousActions: true,
        autonomyLevel: true,
        defaultProvider: true,
        defaultModel: true,
      },
    })
    if (
      !identity ||
      (input.enabled &&
        (!identity.enabled ||
          !['intake.read', 'content.draft'].every((cap) =>
            identity.accessCapabilities.includes(cap),
          ) ||
          !identity.autonomousActions.includes('content.prepare-draft') ||
          identity.autonomyLevel === 'READ_ONLY' ||
          !identity.defaultProvider ||
          !identity.defaultModel))
    )
      throw new IntakeSourceAgentRoutingError(
        'FORBIDDEN',
        'The exact Content identity is not eligible for this source routing policy.',
      )
    const fields = {
      agentIdentityId: input.agentIdentityId,
      enabled: input.enabled,
      updatedBy: actor,
    }
    const policy = current
      ? await tx.intakeSourceAgentRoutingPolicy.update({
          where: { id: current.id, tenantId: input.tenantId, revision: input.expectedRevision },
          data: { ...fields, revision: { increment: 1 } },
        })
      : await tx.intakeSourceAgentRoutingPolicy.create({
          data: { ...fields, tenantId: input.tenantId, venueId: input.venueId, createdBy: actor },
        })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actor: { type: 'HUMAN', actorId: actor, role: 'PLATFORM_ADMIN' },
        action: 'intake-source-agent.routing-configured',
        targetType: 'IntakeSourceAgentRoutingPolicy',
        targetId: policy.id,
        ...(current
          ? {
              beforeState: {
                revision: current.revision,
                enabled: current.enabled,
                agentIdentityId: current.agentIdentityId,
              },
            }
          : {}),
        afterState: {
          revision: policy.revision,
          enabled: policy.enabled,
          agentIdentityId: policy.agentIdentityId,
          venueId: input.venueId,
          taskDispatched: false,
        },
      },
      tx,
    )
    return { policy, taskDispatched: false as const }
  })
}

export type IntakeSourceRoutingTransaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
/** Acquire after source receipt/task operation locks. This supplies routing intent,
 * not execution authority; worker claim/effect checks remain mandatory. */
export async function assertIntakeSourceAgentRoutingInTransaction(
  tx: IntakeSourceRoutingTransaction,
  input: { tenantId: string; venueId: string; agentIdentityId: string; policyRevision: number },
) {
  const parsed = IntakeSourceAgentRoutingInput.parse({
    tenantId: input.tenantId,
    venueId: input.venueId,
    agentIdentityId: input.agentIdentityId,
    expectedRevision: input.policyRevision,
    enabled: true,
  })
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-source-routing:${parsed.tenantId}:${parsed.venueId}`}, 0))`
  const policy = await tx.intakeSourceAgentRoutingPolicy.findFirst({
    where: {
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      agentIdentityId: parsed.agentIdentityId,
      revision: parsed.expectedRevision,
      enabled: true,
    },
  })
  if (!policy)
    throw new IntakeSourceAgentRoutingError(
      'FORBIDDEN',
      'Exact enabled source routing policy is unavailable.',
    )
  return policy
}
