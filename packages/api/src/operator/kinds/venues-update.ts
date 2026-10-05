import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  getVenueBotConfigurationAction,
  updateVenueAction,
  updateVenueAiConfigAction,
  updateVenueBotConfigurationAction,
  updateVenueChatDesignAction,
  VenueActionError,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'
import { venueActor } from './shared'

const input = OPERATOR_MCP_INPUTS['venues.propose_update']
type UpdateArgs = ReturnType<typeof input.parse>

const DETAIL_FIELDS = ['name', 'description', 'guideNotes', 'category'] as const
const AI_FIELDS = ['aiGuideName', 'aiGuideNotes', 'aiTone', 'tonePreset'] as const
const DESIGN_FIELDS = ['chatBannerUrl', 'chatLogoUrl', 'chatShowPhotos', 'chatShowLinks'] as const
const BOT_FIELDS = ['responseDepth', 'greeting', 'publicDisplayName'] as const

function pick<K extends keyof UpdateArgs>(args: UpdateArgs, keys: readonly K[]) {
  return Object.fromEntries(
    keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]),
  ) as Partial<Pick<UpdateArgs, K>>
}

const nonEmpty = (value: object) => Object.keys(value).length > 0

async function readVenue(database: OperatorDatabase, tenantId: string, venueId: string) {
  return database.venue.findFirst({
    where: { id: venueId, tenantId },
    select: {
      id: true,
      updatedAt: true,
      name: true,
      description: true,
      guideNotes: true,
      category: true,
      aiGuideName: true,
      aiGuideNotes: true,
      aiTone: true,
      tonePreset: true,
      chatBannerUrl: true,
      chatLogoUrl: true,
      chatShowPhotos: true,
      chatShowLinks: true,
    },
  })
}

/** A concurrent edit is a stale target, not a failure with an unknown outcome. */
async function guard<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (error instanceof VenueActionError && error.code === 'CONFLICT') {
      throw new OperatorStaleError(error.message)
    }
    if (error instanceof VenueActionError && error.code === 'NOT_FOUND') {
      throw new OperatorNotFoundError()
    }
    throw error
  }
}

/**
 * Changes a venue's details, AI settings, branding images, guide presentation and tone in
 * one operation, through the same canonical actions the dashboard uses. Each group is a separate
 * write at the venue's then-current version, so only the first is bound to expectedUpdatedAt.
 */
export const venuesUpdateKind: OperatorProposalKind<UpdateArgs> = {
  kind: 'venues.update',
  tool: 'venues.propose_update',
  capability: 'venues:propose',
  parse: (raw) => input.parse(raw),
  target: (args) => ({ tenantId: args.tenantId, venueId: args.venueId }),
  authorize: (args, context: OperatorKindContext) =>
    assertVenueInGrant(context.grant, args.tenantId, args.venueId, context.database),
  targetVersion: async (args) =>
    args.expectedUpdatedAt ? new Date(args.expectedUpdatedAt).toISOString() : null,
  currentVersion: async (args, context) =>
    (await readVenue(context.database, args.tenantId, args.venueId))?.updatedAt.toISOString() ??
    null,
  describe: (args) => ({
    title: 'Update venue settings',
    lines: Object.entries(args)
      .filter(([key]) => !['tenantId', 'venueId', 'operationId', 'expectedUpdatedAt'].includes(key))
      .map(([key, value]) => `${key} → ${value === null ? 'cleared' : JSON.stringify(value)}`),
  }),
  snapshot: async (args, context) =>
    JSON.parse(
      JSON.stringify(await readVenue(context.database, args.tenantId, args.venueId)),
    ) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const { tenantId, venueId } = args
    const database = context.database
    const changed: string[] = []
    const current = async () => {
      const venue = await readVenue(database, tenantId, venueId)
      if (!venue) throw new OperatorNotFoundError()
      return venue.updatedAt
    }

    const details = pick(args, DETAIL_FIELDS)
    if (nonEmpty(details)) {
      await guard(() =>
        current().then((updatedAt) =>
          updateVenueAction(
            {
              tenantId,
              venueId,
              expectedUpdatedAt: updatedAt,
              actor: venueActor(context.actor, 'OWNER'),
              fields: details,
            },
            database,
          ),
        ),
      )
      changed.push(...Object.keys(details))
    }

    const ai = pick(args, AI_FIELDS)
    if (nonEmpty(ai)) {
      await guard(() =>
        current().then((updatedAt) =>
          updateVenueAiConfigAction(
            {
              tenantId,
              venueId,
              expectedUpdatedAt: updatedAt,
              actor: venueActor(context.actor, 'OWNER'),
              fields: ai,
            },
            database,
          ),
        ),
      )
      changed.push(...Object.keys(ai))
    }

    const design = pick(args, DESIGN_FIELDS)
    if (nonEmpty(design)) {
      // A link replaces any reviewed derivative, which would otherwise take precedence.
      const fields = {
        ...design,
        ...(design.chatBannerUrl !== undefined
          ? { chatBannerDerivativeId: null, chatBannerDerivativeReceipt: null }
          : {}),
        ...(design.chatLogoUrl !== undefined
          ? { chatLogoDerivativeId: null, chatLogoDerivativeReceipt: null }
          : {}),
      }
      await guard(() =>
        current().then((updatedAt) =>
          updateVenueChatDesignAction(
            { tenantId, venueId, expectedUpdatedAt: updatedAt, actor: context.actor, fields },
            database,
          ),
        ),
      )
      changed.push(...Object.keys(design))
    }

    const bot = pick(args, BOT_FIELDS)
    if (nonEmpty(bot)) {
      await guard(async () => {
        const configuration = await getVenueBotConfigurationAction({ tenantId, venueId }, database)
        return updateVenueBotConfigurationAction(
          {
            tenantId,
            venueId,
            expectedRevision: configuration.revision,
            actor: venueActor(context.actor, 'OWNER'),
            fields: bot,
          },
          database,
        )
      })
      changed.push(...Object.keys(bot))
    }

    const after = await readVenue(database, tenantId, venueId)
    return {
      result: {
        venueId,
        changed,
        updatedAt: after?.updatedAt.toISOString() ?? null,
      },
      after: JSON.parse(JSON.stringify(after)) as JsonValue,
    }
  },
}
