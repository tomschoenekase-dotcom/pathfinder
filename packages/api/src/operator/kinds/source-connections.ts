import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { SOURCE_CONNECTION_PROVIDER } from '@pathfinder/contracts/source-connections'
import {
  approveSourceConnectionPreview,
  createSourceConnectionDraft,
  getSourceConnection,
  requestSourceConnectionPreview,
  requestSourceConnectionRefresh,
  setSourceConnectionState,
  updateSourceConnectionDraft,
} from '../../routers/source-connections-actions'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorKindContext, OperatorProposalKind } from '../proposals'

const schema = OPERATOR_MCP_INPUTS['venues.propose_source_connection']
type Args = ReturnType<typeof schema.parse>
const scope = (args: Args, context: OperatorKindContext) => ({
  tenantId: args.tenantId,
  venueId: args.venueId,
  connectorId: args.connectorId!,
  database: context.database,
})
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

export const sourceConnectionKind: OperatorProposalKind<Args> = {
  kind: 'venues.source-connection',
  tool: 'venues.propose_source_connection',
  capability: 'venues:propose',
  parse: (raw) => schema.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: async (args, context) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    if (args.action !== 'create') {
      const found = await context.database.liveDataConnector.findFirst({
        where: {
          id: args.connectorId!,
          tenantId: args.tenantId,
          venueId: args.venueId,
          provider: SOURCE_CONNECTION_PROVIDER,
        },
        select: { id: true },
      })
      if (!found) throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) => (args.action === 'create' ? null : args.expectedUpdatedAt!),
  currentVersion: async (args, context) => {
    if (args.action === 'create') return null
    return (await getSourceConnection(scope(args, context))).updatedAt.toISOString()
  },
  describe: (args) => ({
    title: `Source connection: ${args.action}`,
    lines: [
      `Venue: ${args.venueId}. Connection: ${args.connectorId ?? 'new draft'}.`,
      ...(args.name ? [`Name: ${args.name}`] : []),
      ...(args.config ? [`Exact configuration: ${JSON.stringify(args.config)}`] : []),
      ...(args.previewHash
        ? [
            `Approve preview ${args.previewId}: ${args.previewHash}. Valid updates will follow the reviewed publication policy.`,
          ]
        : []),
      'Website content is untrusted. Mapping or policy changes require a fresh preview and approval.',
    ],
  }),
  snapshot: async (args, context) =>
    args.action === 'create' ? null : json(await getSourceConnection(scope(args, context))),
  apply: async (args, context) => {
    const common = {
      ...scope(args, context),
      actorId: context.actor.id,
      actorRole: context.actor.role,
      expectedUpdatedAt: args.expectedUpdatedAt!,
    }
    let result: unknown
    switch (args.action) {
      case 'create':
        result = await createSourceConnectionDraft({
          tenantId: args.tenantId,
          venueId: args.venueId,
          name: args.name!,
          config: args.config!,
          actorId: context.actor.id,
          actorRole: context.actor.role,
          operationId: context.operationId,
          database: context.database,
        })
        break
      case 'update':
        result = await updateSourceConnectionDraft({ ...common, config: args.config! })
        break
      case 'preview':
        result = await requestSourceConnectionPreview(common)
        break
      case 'approve':
        result = await approveSourceConnectionPreview({
          ...common,
          previewId: args.previewId!,
          previewHash: args.previewHash!,
        })
        break
      case 'pause':
        result = await setSourceConnectionState({ ...common, state: 'DISABLED' })
        break
      case 'resume':
        result = await setSourceConnectionState({ ...common, state: 'ACTIVE' })
        break
      case 'refresh':
        result = await requestSourceConnectionRefresh(common)
        break
    }
    return { result: { action: args.action, outcome: json(result) }, after: json(result) }
  },
  reconcile: async (args, context) => {
    if (args.action !== 'create') return { state: 'unknown' }
    // Creation has a durable unique resource ID derived from the approved operation. Other
    // ambiguous outcomes stay held rather than repeating a policy change or provider request.
    const row = await context.database.liveDataConnector.findFirst({
      where: {
        tenantId: args.tenantId,
        venueId: args.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
        resourceId: `source_${context.operationId}`,
      },
      select: { id: true, state: true },
    })
    if (!row) return { state: 'not_applied' }
    return {
      state: 'applied',
      outcome: { result: { action: 'create', connectorId: row.id }, after: json(row) },
    }
  },
}
