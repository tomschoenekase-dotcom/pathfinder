import { AI_CENTRAL_MODEL_REGISTRY, getAiModelSpec } from '@pathfinder/ai'
import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  AiConfigurationActionError,
  resetAiWorkloadConfigurationOverrideAction,
  saveAiWorkloadConfigurationOverrideAction,
  type AiConfigurationScope,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  describeGuestModelSource,
  GUEST_CHAT_WORKLOAD,
  GUEST_MODEL_CHOICES,
  guestModelAvailable,
  guestModelVersion,
  liveOverrideValues,
  otherOverrideSettings,
  readGuestModelState,
  readVenueGuestModelOverride,
} from '../guest-model'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'
import { operatorReason } from './shared'

const setInput = OPERATOR_MCP_INPUTS['venues.propose_guest_model']
const resetInput = OPERATOR_MCP_INPUTS['venues.propose_guest_model_reset']
type SetArgs = ReturnType<typeof setInput.parse>
type ResetArgs = ReturnType<typeof resetInput.parse>
type VenueArgs = Readonly<{
  tenantId: string
  venueId: string
  expectedRevision?: number | null | undefined
}>

/** Recheck at the domain boundary, including no-op paths, after the proposal-level check. */
function assertExpectedRevision(args: VenueArgs, revision: number | null | undefined) {
  if (args.expectedRevision !== undefined && args.expectedRevision !== (revision ?? null)) {
    throw new OperatorStaleError(
      'The venue model settings changed; read them again before retrying.',
    )
  }
}

/** The deployment has no execution key for the chosen model's provider; nothing was recorded. */
export class GuestModelUnavailableError extends Error {
  readonly code = 'MODEL_UNAVAILABLE'
}

function venueScope(args: VenueArgs): AiConfigurationScope {
  return {
    level: 'VENUE',
    tenantId: args.tenantId,
    venueId: args.venueId,
    workloadId: GUEST_CHAT_WORKLOAD,
  }
}

/**
 * The save and reset actions run in one transaction, so their refusals changed nothing. A
 * concurrent change is a stale target; a vanished venue is NOT_FOUND.
 */
async function guard<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof AiConfigurationActionError) {
      if (error.code === 'CONFLICT') throw new OperatorStaleError(error.message)
      if (error.code === 'NOT_FOUND') throw new OperatorNotFoundError()
      Object.assign(error, { provedNoEffect: true })
    }
    throw error
  }
}

async function snapshot(database: OperatorDatabase, args: VenueArgs): Promise<JsonValue> {
  const { effective, row } = await readGuestModelState(database, args.tenantId, args.venueId)
  return {
    venueId: args.venueId,
    effectiveModelKey: effective.primaryModelKey,
    effectiveSource: effective.sources.primaryModelKey,
    venueOverride: row
      ? {
          revision: row.revision,
          active: row.enabled && !row.isTombstone,
          modelKey: liveOverrideValues(row).primaryModelKey ?? null,
          otherSettings: otherOverrideSettings(row),
        }
      : null,
  }
}

const sharedTarget = {
  target: (args: VenueArgs) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  targetVersion: async (args: VenueArgs) =>
    args.expectedRevision === undefined ? null : guestModelVersion(args.expectedRevision),
  currentVersion: async (args: VenueArgs, context: OperatorKindContext) =>
    guestModelVersion(
      (await readVenueGuestModelOverride(context.database, args.tenantId, args.venueId))
        ?.revision ?? null,
    ),
  snapshot: (args: VenueArgs, context: OperatorKindContext) => snapshot(context.database, args),
}

type Snapshot = { effectiveModelKey: string; effectiveSource: string }

/** API model id and Fast mode for a resolved key, from the same registry routing uses. */
function modelDetail(modelKey: string): { model: string | null; fastMode: boolean } {
  const central = (AI_CENTRAL_MODEL_REGISTRY as Record<string, { model: string } | undefined>)[
    modelKey
  ]
  const spec = central
    ? (getAiModelSpec(modelKey as never) as { serviceTier?: string } | undefined)
    : undefined
  return { model: central?.model ?? null, fastMode: spec?.serviceTier === 'fast' }
}

/**
 * The receipt: what answered this venue before, what answers it now and why, and that only this
 * venue changed.
 */
async function outcome(
  context: OperatorApplyContext,
  args: VenueArgs,
  before: JsonValue,
  result: Record<string, JsonValue>,
) {
  const after = await snapshot(context.database, args)
  const previous = before as Snapshot
  const now = after as Snapshot
  return {
    result: {
      venueId: args.venueId,
      scope: 'this venue only',
      ...result,
      effectiveModelKey: now.effectiveModelKey,
      previous: {
        modelKey: previous.effectiveModelKey,
        source: describeGuestModelSource(previous.effectiveSource).source,
        ...modelDetail(previous.effectiveModelKey),
      },
      effective: {
        modelKey: now.effectiveModelKey,
        source: describeGuestModelSource(now.effectiveSource).source,
        ...modelDetail(now.effectiveModelKey),
      },
    },
    after,
  }
}

/**
 * Picks the visitor chat model for one venue with a venue-scoped guest-chat override, through the
 * same canonical save action the admin dashboard uses. Other stored settings on the row are kept.
 */
export const venuesGuestModelKind: OperatorProposalKind<SetArgs> = {
  kind: 'venues.guest-model',
  tool: 'venues.propose_guest_model',
  capability: 'venues:propose',
  parse: (raw) => setInput.parse(raw),
  ...sharedTarget,
  authorize: async (args, context) => {
    await assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
    if (!guestModelAvailable(args.modelKey)) {
      throw new GuestModelUnavailableError(
        `This deployment has no provider key for ${args.modelKey}; choose an available model.`,
      )
    }
  },
  describe: (args) => ({
    title: 'Set visitor chat model',
    lines: [
      `model → ${args.modelKey} (${GUEST_MODEL_CHOICES[args.modelKey].title})`,
      ...(args.reason ? [`reason → ${JSON.stringify(args.reason)}`] : []),
    ],
  }),
  apply: async (args, context) => {
    const before = await snapshot(context.database, args)
    const row = await readVenueGuestModelOverride(context.database, args.tenantId, args.venueId)
    assertExpectedRevision(args, row?.revision)
    const values = liveOverrideValues(row)
    if (row && !row.isTombstone && row.enabled && values.primaryModelKey === args.modelKey) {
      return outcome(context, args, before, {
        modelKey: args.modelKey,
        changed: false,
        revision: row.revision,
      })
    }
    const saved = await guard(() =>
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope: venueScope(args),
          actor: context.actor,
          expectedRevision: row?.revision ?? null,
          enabled: true,
          values: { ...values, primaryModelKey: args.modelKey },
          // A different primary model always counts as a spend change; this call is the
          // explicit, scoped approval for exactly that one venue and key.
          unsafeChangesEnabled: true,
          reason: `${operatorReason(context.proposalId)}: ${args.reason ?? `visitor chat model ${args.modelKey}`}`,
        },
        context.database,
      ),
    )
    return outcome(context, args, before, {
      modelKey: args.modelKey,
      changed: true,
      revision: saved.revision,
    })
  },
}

/**
 * Removes the venue's own model choice so the venue follows the client, workload or deployment
 * default again. A row with no other settings is reset (tombstoned); otherwise only the model
 * key is cleared and the other settings stay. No model override means nothing changes.
 */
export const venuesGuestModelResetKind: OperatorProposalKind<ResetArgs> = {
  kind: 'venues.guest-model-reset',
  tool: 'venues.propose_guest_model_reset',
  capability: 'venues:propose',
  parse: (raw) => resetInput.parse(raw),
  ...sharedTarget,
  authorize: (args, context) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  describe: (args) => ({
    title: 'Reset visitor chat model to the default',
    lines: [
      'model → inherited default',
      ...(args.reason ? [`reason → ${JSON.stringify(args.reason)}`] : []),
    ],
  }),
  apply: async (args, context) => {
    const before = await snapshot(context.database, args)
    const row = await readVenueGuestModelOverride(context.database, args.tenantId, args.venueId)
    assertExpectedRevision(args, row?.revision)
    const values = liveOverrideValues(row)
    if (!row || values.primaryModelKey === undefined) {
      return outcome(context, args, before, { changed: false, revision: row?.revision ?? null })
    }
    const reason = `${operatorReason(context.proposalId)}: ${args.reason ?? 'visitor chat model reset to default'}`
    const { primaryModelKey: _cleared, ...others } = values
    void _cleared
    const saved = await guard(() =>
      Object.keys(others).length === 0
        ? resetAiWorkloadConfigurationOverrideAction(
            {
              scope: venueScope(args),
              actor: context.actor,
              expectedRevision: row.revision,
              reason,
            },
            context.database,
          )
        : saveAiWorkloadConfigurationOverrideAction(
            {
              scope: venueScope(args),
              actor: context.actor,
              expectedRevision: row.revision,
              enabled: row.enabled,
              values: others,
              // Returning to the inherited model is still a model change to the resolver.
              unsafeChangesEnabled: true,
              reason,
            },
            context.database,
          ),
    )
    return outcome(context, args, before, { changed: true, revision: saved.revision })
  },
}

export const VENUE_GUEST_MODEL_KINDS = [venuesGuestModelKind, venuesGuestModelResetKind] as const
