import { z } from 'zod'
import { db } from '../client'
import { ProspectSalesError } from './prospect-sales-snapshot'

const invocationSchema = z.object({
  tenantId: z.string().trim().min(1).max(191),
  venueId: z.string().trim().min(1).max(191),
  sessionId: z.string().uuid(),
  agentRunId: z.string().trim().min(1).max(191),
  leaseToken: z.string().uuid(),
  credentialId: z.string().trim().min(1).max(191),
  correlationId: z.string().uuid(),
}).strict()
export type NativeSalesWriterInvocation = z.infer<typeof invocationSchema>
const scopeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ALL') }).strict(),
  z.object({ mode: z.literal('TERRITORIES'),
    territoryIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100) }).strict(),
])
const frozenSchema = z.object({
  accessCapabilities: z.array(z.string()), prospectScope: scopeSchema,
  promptIdentity: z.string().trim().min(1).max(191),
}).passthrough()
const requiredCapabilities = ['prospects.native-writer',
  'prospects.correspondence.read'] as const

/** The bridge can request this actor, but cannot construct or serialize its
 * authority. Invocation and scope remain in a module-private WeakMap. */
export type NativeSalesWriterAgentActor = Readonly<{
  type: 'AGENT'
  role: 'NATIVE_SALES_WRITER'
  id: string
}>
type Binding = {
  invocation: NativeSalesWriterInvocation
  venueId: string
  organizationId: string
}
const issued = new WeakMap<NativeSalesWriterAgentActor, Binding>()
type ReadClient = Pick<typeof db, 'agentRun' | 'prospectVenue'>
function deny(): never {
  throw new ProspectSalesError('FORBIDDEN',
    'Live leased native-writer grant and exact prospect scope are required')
}

export function assertIssuedNativeSalesWriterAgent(actor: NativeSalesWriterAgentActor) {
  if (!actor || actor.type !== 'AGENT' || actor.role !== 'NATIVE_SALES_WRITER' ||
      !issued.has(actor)) deny()
}

/** Repeated at API entry, after long component work, and inside serializable
 * native mutations. The venue/organization/territory check is one predicate. */
export async function revalidateNativeSalesWriterAgent(
  actor: NativeSalesWriterAgentActor,
  venueId: string,
  organizationId: string,
  client: ReadClient = db,
) {
  assertIssuedNativeSalesWriterAgent(actor)
  const binding = issued.get(actor)!
  if (binding.venueId !== venueId || binding.organizationId !== organizationId)
    deny()
  const input = binding.invocation
  const now = new Date()
  const run = await client.agentRun.findFirst({
    where: {
      id: input.agentRunId, tenantId: input.tenantId, venueId: input.venueId,
      status: 'RUNNING', executionLeaseToken: input.leaseToken,
      executionLeaseExpiresAt: { gt: now },
      executionBridgeSessionId: input.sessionId,
      executionBridgeSession: { credentialId: input.credentialId,
        status: 'ONLINE', expiresAt: { gt: now } },
      agentIdentity: { enabled: true },
    },
    select: { agentIdentity: { select: { id: true, accessCapabilities: true } },
      scopeSnapshot: true },
  })
  const frozen = frozenSchema.safeParse(run?.scopeSnapshot)
  if (!run || !frozen.success || run.agentIdentity.id !== actor.id ||
      !requiredCapabilities.every((capability) =>
        run.agentIdentity.accessCapabilities.includes(capability) &&
        frozen.data.accessCapabilities.includes(capability))) deny()
  const scope = frozen.data.prospectScope
  const venue = await client.prospectVenue.findFirst({
    where: { id: venueId, organizationId, archivedAt: null,
      organization: { archivedAt: null,
        ...(scope.mode === 'TERRITORIES'
          ? { territoryId: { in: [...new Set(scope.territoryIds)] } } : {}) } },
    select: { id: true },
  })
  if (!venue) deny()
}

export async function revalidateNativeSalesWriterAgentBound(
  actor: NativeSalesWriterAgentActor, venueId: string, client: ReadClient = db,
) {
  assertIssuedNativeSalesWriterAgent(actor)
  await revalidateNativeSalesWriterAgent(actor, venueId,
    issued.get(actor)!.organizationId, client)
}

export async function issueNativeSalesWriterAgentActor(input: {
  invocation: NativeSalesWriterInvocation
  venueId: string
  organizationId: string
}) {
  const parsed = invocationSchema.parse(input.invocation)
  const actor: NativeSalesWriterAgentActor = Object.freeze({
    type: 'AGENT', role: 'NATIVE_SALES_WRITER', id: '',
  })
  // The live identity is read by the same validation used on every later call.
  const run = await db.agentRun.findFirst({
    where: { id: parsed.agentRunId, tenantId: parsed.tenantId,
      venueId: parsed.venueId, status: 'RUNNING',
      executionLeaseToken: parsed.leaseToken,
      executionLeaseExpiresAt: { gt: new Date() },
      executionBridgeSessionId: parsed.sessionId,
      executionBridgeSession: { credentialId: parsed.credentialId,
        status: 'ONLINE', expiresAt: { gt: new Date() } },
      agentIdentity: { enabled: true } },
    select: { agentIdentity: { select: { id: true } } },
  })
  if (!run) deny()
  const verified = Object.freeze({ ...actor, id: run.agentIdentity.id })
  issued.set(verified, { invocation: parsed,
    venueId: input.venueId, organizationId: input.organizationId })
  await revalidateNativeSalesWriterAgent(verified,
    input.venueId, input.organizationId)
  return verified
}
