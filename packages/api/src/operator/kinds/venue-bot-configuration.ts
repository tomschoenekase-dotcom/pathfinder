import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  getVenueBotConfigurationAction,
  updateVenueBotConfigurationAction,
  createPersonalityProfileAction,
  updatePersonalityProfileAction,
  VenueActionError,
} from '@pathfinder/db'
import { requireCharacterConfigurationRollout } from '../../lib/character-configuration-rollout'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorProposalKind,
  type OperatorKindContext,
} from '../proposals'
import { venueActor } from './shared'

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof VenueActionError && error.code === 'CONFLICT')
      throw new OperatorStaleError(error.message)
    if (error instanceof VenueActionError && error.code === 'NOT_FOUND')
      throw new OperatorNotFoundError()
    throw error
  }
}
const configInput = OPERATOR_MCP_INPUTS['venues.propose_bot_configuration']
type ConfigArgs = ReturnType<typeof configInput.parse>
const authorize = (args: { tenantId: string; venueId: string }, context: OperatorKindContext) =>
  assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database)
export const venueBotConfigurationKind: OperatorProposalKind<ConfigArgs> = {
  kind: 'venues.bot-configuration',
  tool: 'venues.propose_bot_configuration',
  capability: 'venues:propose',
  parse: (raw) => configInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize,
  targetVersion: async (args) => String(args.configuration.expectedRevision),
  currentVersion: async (args, context) =>
    String((await getVenueBotConfigurationAction(args, context.database)).revision),
  describe: () => ({
    title: 'Update bot configuration',
    lines: ['Apply typed configuration fields at the expected revision.'],
  }),
  snapshot: async (args, context) =>
    json(await getVenueBotConfigurationAction(args, context.database)),
  apply: async (args, context) => {
    const { venueId, expectedRevision, ...fields } = args.configuration
    if (
      fields.presentationMode === 'CHARACTER' ||
      typeof fields.characterKey === 'string' ||
      typeof fields.customCharacterId === 'string'
    )
      await requireCharacterConfigurationRollout(
        context.database,
        args.tenantId,
        fields.characterKey,
      )
    const after = await guard(() =>
      updateVenueBotConfigurationAction(
        {
          tenantId: args.tenantId,
          venueId,
          expectedRevision,
          fields,
          actor: venueActor(context.actor, 'OWNER'),
        },
        context.database,
      ),
    )
    return { result: { venueId: args.venueId, configuration: after }, after: json(after) }
  },
}
const createInput = OPERATOR_MCP_INPUTS['venues.propose_personality_profile_create']
type CreateArgs = ReturnType<typeof createInput.parse>
export const venuePersonalityCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'venues.personality-profile-create',
  tool: 'venues.propose_personality_profile_create',
  capability: 'venues:propose',
  parse: (raw) => createInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize,
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({ title: 'Create personality profile', lines: [args.profile.name] }),
  snapshot: async () => null,
  apply: async (args, context) => {
    const after = await guard(() =>
      createPersonalityProfileAction(
        {
          tenantId: args.tenantId,
          venueId: args.venueId,
          profile: args.profile,
          actor: venueActor(context.actor, 'OWNER'),
        },
        context.database,
      ),
    )
    return {
      result: { venueId: args.venueId, profileId: after.id, profile: json(after) },
      after: json(after),
    }
  },
}
const updateInput = OPERATOR_MCP_INPUTS['venues.propose_personality_profile_update']
type UpdateArgs = ReturnType<typeof updateInput.parse>
async function readProfile(args: UpdateArgs, context: OperatorKindContext) {
  return context.database.personalityProfile.findFirst({
    where: { id: args.profileId, tenantId: args.tenantId, venueId: args.venueId, status: 'ACTIVE' },
    select: {
      id: true,
      revision: true,
      name: true,
      warmth: true,
      brevity: true,
      energy: true,
      formality: true,
      customInstruction: true,
    },
  })
}
export const venuePersonalityUpdateKind: OperatorProposalKind<UpdateArgs> = {
  kind: 'venues.personality-profile-update',
  tool: 'venues.propose_personality_profile_update',
  capability: 'venues:propose',
  parse: (raw) => updateInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize,
  targetVersion: async (args) => String(args.expectedRevision),
  currentVersion: async (args, context) => {
    const current = await readProfile(args, context)
    return current ? String(current.revision) : null
  },
  describe: (args) => ({ title: 'Update personality profile', lines: [args.profile.name] }),
  snapshot: async (args, context) => json(await readProfile(args, context)),
  apply: async (args, context) => {
    const after = await guard(() =>
      updatePersonalityProfileAction(
        {
          tenantId: args.tenantId,
          venueId: args.venueId,
          profileId: args.profileId,
          expectedRevision: args.expectedRevision,
          profile: args.profile,
          actor: venueActor(context.actor, 'OWNER'),
        },
        context.database,
      ),
    )
    return {
      result: { venueId: args.venueId, profileId: after.id, profile: json(after) },
      after: json(after),
    }
  },
}
export const VENUE_BOT_CONFIGURATION_KINDS = [
  venueBotConfigurationKind,
  venuePersonalityCreateKind,
  venuePersonalityUpdateKind,
]
