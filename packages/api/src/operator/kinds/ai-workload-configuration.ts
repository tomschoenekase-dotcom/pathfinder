import { AI_CENTRAL_MODEL_REGISTRY } from '@pathfinder/ai'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import {
  AiConfigurationActionError,
  saveAiWorkloadConfigurationOverrideAction,
  resetAiWorkloadConfigurationOverrideAction,
} from '@pathfinder/db'
import { saveInputSchema } from '../../routers/admin/ai-workload-configuration-inputs'
import { providerHasExecutionKey } from '../../routers/admin/ai-provider-connections'
import {
  readVenueAiConfiguration,
  readVenueAiOverride,
  venueAiScope,
} from '../ai-workload-configuration'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'

const saveSchema = OPERATOR_MCP_INPUTS['venues.propose_ai_workload_configuration']
const resetSchema = OPERATOR_MCP_INPUTS['venues.propose_ai_workload_reset']
type SaveArgs = ReturnType<typeof saveSchema.parse>
type ResetArgs = ReturnType<typeof resetSchema.parse>
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
const target = (args: { tenantId: string; venueId: string }) => ({
  tenantId: args.tenantId,
  venueId: args.venueId,
})
async function authorize(args: SaveArgs | ResetArgs, context: OperatorKindContext) {
  // Operator OAuth is restricted to allowlisted platform administrators. Refresh the owner
  // allowlist here as well; no actor role is synthesized to bypass the canonical admin action.
  if (!context.allowedUserIds?.has(context.grant.userId)) throw new OperatorNotFoundError()
  await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
}
async function guard<T>(run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof AiConfigurationActionError && error.code === 'CONFLICT')
      throw new OperatorStaleError(error.message)
    if (error instanceof AiConfigurationActionError && error.code === 'NOT_FOUND')
      throw new OperatorNotFoundError()
    throw error
  }
}
const currentVersion = async (args: SaveArgs | ResetArgs, context: OperatorKindContext) => {
  const row = await readVenueAiOverride(args, context.database)
  return row ? String(row.revision) : null
}
const snapshot = async (args: SaveArgs | ResetArgs, context: OperatorKindContext) =>
  json(await readVenueAiConfiguration(args, context.database))

export const venueAiConfigurationKind: OperatorProposalKind<SaveArgs> = {
  kind: 'venues.ai-workload-configuration',
  tool: 'venues.propose_ai_workload_configuration',
  capability: 'venues:propose',
  parse(raw) {
    const args = saveSchema.parse(raw)
    saveInputSchema.parse({ ...argsForSave(args), scope: venueAiScope(args) })
    return args
  },
  target,
  authorize,
  targetVersion: async (args) =>
    args.expectedRevision === null ? null : String(args.expectedRevision),
  currentVersion,
  snapshot,
  describe: (args) => ({
    title: 'Save venue AI workload override',
    lines: [
      `Workload: ${args.workloadId}; enabled: ${args.enabled}; unsafe changes: ${args.unsafeChangesEnabled}.`,
      `Replace override values: ${JSON.stringify(args.values)}. Omitted fields inherit lower layers.`,
      'No provider call; later runtime requests may spend budget. Runtime budget gates remain authoritative.',
    ],
  }),
  async apply(args, context) {
    const input = saveInputSchema.parse({ ...argsForSave(args), scope: venueAiScope(args) })
    const selected = [
      ...(input.values.primaryModelKey ? [input.values.primaryModelKey] : []),
      ...(input.values.fallback?.enabled ? input.values.fallback.modelKeys : []),
    ]
    if (
      input.enabled &&
      selected.some((key) => !providerHasExecutionKey(AI_CENTRAL_MODEL_REGISTRY[key].provider))
    )
      throw new Error('Cannot enable this AI route because provider configuration is missing')
    const saved = await guard(() =>
      saveAiWorkloadConfigurationOverrideAction(
        { ...input, actor: context.actor },
        context.database,
      ),
    )
    const after = await readVenueAiConfiguration(args, context.database)
    return {
      result: { revision: saved.revision, enabled: saved.enabled, configuration: json(after) },
      after: json(after),
    }
  },
}
function argsForSave(args: SaveArgs) {
  return {
    expectedRevision: args.expectedRevision,
    enabled: args.enabled,
    values: args.values,
    unsafeChangesEnabled: args.unsafeChangesEnabled,
    reason: args.reason,
  }
}
export const venueAiResetKind: OperatorProposalKind<ResetArgs> = {
  kind: 'venues.ai-workload-reset',
  tool: 'venues.propose_ai_workload_reset',
  capability: 'venues:propose',
  parse(raw) {
    const args = resetSchema.parse(raw)
    venueAiScope(args)
    return args
  },
  target,
  authorize,
  targetVersion: async (args) => String(args.expectedRevision),
  currentVersion,
  snapshot,
  describe: (args) => ({
    title: 'Reset venue AI workload override',
    lines: [
      `Workload: ${args.workloadId}. Inherit lower configuration layers; future runtime costs may change.`,
    ],
  }),
  async apply(args, context) {
    const saved = await guard(() =>
      resetAiWorkloadConfigurationOverrideAction(
        {
          scope: venueAiScope(args),
          expectedRevision: args.expectedRevision,
          reason: args.reason,
          actor: context.actor,
        },
        context.database,
      ),
    )
    const after = await readVenueAiConfiguration(args, context.database)
    return {
      result: { revision: saved.revision, isTombstone: saved.isTombstone, configuration: json(after) },
      after: json(after),
    }
  },
}
export const VENUE_AI_CONFIGURATION_KINDS = [venueAiConfigurationKind, venueAiResetKind]
