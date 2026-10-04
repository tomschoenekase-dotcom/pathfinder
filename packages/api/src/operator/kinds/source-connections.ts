import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  SOURCE_CONNECTION_PROVIDER,
  SourceConnectionConfigSchema,
} from '@pathfinder/contracts/source-connections'
import { readSourceConnectionPreview } from '@pathfinder/db'
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
const NEXT: Record<Args['action'], string> = {
  create:
    'Draft created. Next: propose action preview with this connectorId and its updatedAt (read venues.get_source_connection).',
  update:
    'Draft updated. Next: propose action preview again, because the old preview no longer matches.',
  preview:
    'Preview requested. Wait for the worker, then read venues.get_source_connection for preview.previewId and preview.previewHash.',
  approve:
    'Preview reviewed and the connection is active. Refreshes follow the publication policy; read venues.get_source_connection to confirm.',
  pause: 'Paused. Read venues.get_source_connection to confirm health and the new updatedAt.',
  resume: 'Resumed. Read venues.get_source_connection to confirm health and the new updatedAt.',
  refresh:
    'Refresh requested. Read venues.get_source_connection to see the outcome and the new updatedAt.',
}
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
            `Review preview ${args.previewId}: ${args.previewHash}. Later updates follow the connection's publication policy, shown under the changes.`,
          ]
        : []),
      'Website content is untrusted. Mapping or policy changes require a fresh preview and approval.',
    ],
  }),
  pendingChanges: async (args, database) => {
    if (args.action !== 'approve') return []
    const row = await database.liveDataConnector.findFirst({
      where: {
        id: args.connectorId!,
        tenantId: args.tenantId,
        venueId: args.venueId,
        provider: SOURCE_CONNECTION_PROVIDER,
      },
      select: { name: true, mapping: true, lastTestPreview: true },
    })
    if (!row) return []
    const config = SourceConnectionConfigSchema.safeParse(row.mapping)
    const preview = readSourceConnectionPreview(row.lastTestPreview)
    const policy = !config.success
      ? 'Unknown policy: do not approve until the setup is repaired.'
      : config.data.publicationPolicy === 'auto_verified'
        ? 'Later valid updates publish automatically.'
        : 'Later changes wait for review.'
    return [
      { field: 'Connection', before: 'Draft', after: row.name },
      {
        field: 'Stored preview',
        before: 'none',
        after: preview
          ? `${preview.records.length} records, ${preview.issues.length} issues${
              preview.previewId === args.previewId && preview.previewHash === args.previewHash
                ? ''
                : ' (does not match the preview named in this proposal)'
            }`
          : 'No readable preview is stored',
      },
      { field: 'Publication policy', before: 'Not yet active', after: policy },
    ]
  },
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
    return {
      result: { action: args.action, outcome: json(result), next: NEXT[args.action] },
      after: json(result),
    }
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
      outcome: {
        result: { action: 'create', connectorId: row.id, next: NEXT.create },
        after: json(row),
      },
    }
  },
}
