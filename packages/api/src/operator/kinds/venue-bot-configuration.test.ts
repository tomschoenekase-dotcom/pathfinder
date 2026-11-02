/* eslint-disable @typescript-eslint/no-explicit-any -- scoped canonical-action fakes */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  profileUpdate: vi.fn(),
  rollout: vi.fn(),
}))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  getVenueBotConfigurationAction: mocks.get,
  listPersonalityProfilesAction: mocks.list,
  updateVenueBotConfigurationAction: mocks.update,
  createPersonalityProfileAction: mocks.create,
  updatePersonalityProfileAction: mocks.profileUpdate,
}))
vi.mock('../../lib/character-configuration-rollout', () => ({
  requireCharacterConfigurationRollout: mocks.rollout,
}))
import { VenueActionError } from '@pathfinder/db'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_TOOLS } from '@pathfinder/contracts/operator-mcp'
import { venueBotConfigurationReadTools } from '../tools/venue-bot-configuration'
import {
  venueBotConfigurationKind as config,
  venuePersonalityCreateKind as create,
  venuePersonalityUpdateKind as update,
} from './venue-bot-configuration'
const context = () =>
  ({
    database: {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-a' }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-a' }) },
      personalityProfile: {
        findFirst: vi.fn().mockResolvedValue({ id: 'profile-a', revision: 3 }),
      },
    },
    grant: { allTenants: false, tenantIds: ['tenant-a'] },
    actor: { type: 'HUMAN', id: 'human', role: 'PLATFORM_ADMIN' },
  }) as any
const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const operationId = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
const profile = {
  name: 'Staff',
  bounds: { warmth: 0.8, brevity: 0.7, energy: 0.5, formality: 0.3 },
}
const args = (configuration = {}) =>
  config.parse({
    ...scope,
    operationId,
    configuration: {
      venueId: scope.venueId,
      expectedRevision: 4,
      personalityMode: 'CUSTOM',
      personalityProfileId: 'profile-a',
      ...configuration,
    },
  })
beforeEach(() => {
  vi.clearAllMocks()
  mocks.get.mockResolvedValue({ revision: 4 })
  mocks.update.mockResolvedValue({ revision: 5 })
  mocks.list.mockResolvedValue([])
  mocks.rollout.mockResolvedValue(undefined)
})
describe('bot configuration operator scope and canonical writes', () => {
  it.each(venueBotConfigurationReadTools.map((tool) => tool.name))(
    'refuses sibling tenant before reading %s',
    async (name) => {
      const tool = venueBotConfigurationReadTools.find((tool) => tool.name === name)!
      await expect(
        tool.handler({ ...scope, tenantId: 'tenant-b' }, context()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(mocks.get).not.toHaveBeenCalled()
      expect(mocks.list).not.toHaveBeenCalled()
    },
  )
  it('refuses a venue belonging to another tenant and scopes profile reads', async () => {
    const ctx = context()
    ctx.database.venue.findFirst.mockResolvedValue(null)
    await expect(venueBotConfigurationReadTools[0]!.handler(scope, ctx)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(mocks.get).not.toHaveBeenCalled()
    await venueBotConfigurationReadTools[1]!.handler(scope, context())
    expect(mocks.list).toHaveBeenCalledWith(scope, expect.anything())
  })
  it.each([config, create, update])('refuses proposal outside the grant', async (kind) => {
    await expect(
      kind.authorize!({ ...scope, tenantId: 'tenant-b' } as any, context()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.profileUpdate).not.toHaveBeenCalled()
  })
  it('selects a custom profile through the canonical action at the exact revision', async () => {
    await config.apply(args(), context())
    expect(mocks.update).toHaveBeenCalledWith(
      {
        ...scope,
        expectedRevision: 4,
        fields: { personalityMode: 'CUSTOM', personalityProfileId: 'profile-a' },
        actor: { type: 'HUMAN', id: 'human', role: 'OWNER' },
      },
      expect.anything(),
    )
    expect(mocks.rollout).not.toHaveBeenCalled()
    expect(await config.targetVersion(args(), context())).toBe('4')
    expect(await config.currentVersion(args(), context())).toBe('4')
  })
  it('maps canonical revision conflicts to STALE and missing profiles to NOT_FOUND', async () => {
    mocks.update.mockRejectedValue(new VenueActionError('CONFLICT', 'changed'))
    await expect(config.apply(args(), context())).rejects.toMatchObject({ code: 'STALE' })
    mocks.profileUpdate.mockRejectedValue(new VenueActionError('NOT_FOUND', 'missing'))
    await expect(
      update.apply(
        update.parse({
          ...scope,
          operationId,
          profileId: 'profile-a',
          expectedRevision: 3,
          profile,
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    mocks.profileUpdate.mockRejectedValue(new VenueActionError('CONFLICT', 'changed'))
    await expect(
      update.apply(
        update.parse({
          ...scope,
          operationId,
          profileId: 'profile-a',
          expectedRevision: 3,
          profile,
        }),
        context(),
      ),
    ).rejects.toMatchObject({ code: 'STALE' })
  })
  it('runs the shared rollout gate before any character update and honors denial', async () => {
    mocks.rollout.mockRejectedValue(new Error('rollout disabled'))
    await expect(
      config.apply(args({ presentationMode: 'CHARACTER', characterKey: 'tochi' }), context()),
    ).rejects.toThrow('rollout disabled')
    expect(mocks.rollout).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'tochi')
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('passes voice selection through canonical validation and rejects mismatched venue IDs or raw fields', async () => {
    await config.apply(args({ voiceProfileId: 'voice-a' }), context())
    expect(mocks.update.mock.calls[0]![0].fields.voiceProfileId).toBe('voice-a')
    expect(() => args({ venueId: 'venue-b' })).toThrow()
    expect(() => args({ arbitrary: true })).toThrow()
  })
  it('creates a bounded profile and preserves scoped profile revisions', async () => {
    mocks.create.mockResolvedValue({ id: 'profile-a', revision: 1 })
    const result = await create.apply(create.parse({ ...scope, operationId, profile }), context())
    expect(result.result).toMatchObject({ profileId: 'profile-a' })
    const updateArgs = update.parse({
      ...scope,
      operationId,
      profileId: 'profile-a',
      expectedRevision: 3,
      profile,
    })
    const ctx = context()
    expect(await update.currentVersion(updateArgs, ctx)).toBe('3')
    expect(ctx.database.personalityProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'profile-a', ...scope, status: 'ACTIVE' } }),
    )
    expect(
      OPERATOR_MCP_INPUTS['venues.propose_personality_profile_create'].safeParse({
        ...scope,
        operationId,
        profile: { ...profile, bounds: { ...profile.bounds, warmth: 2 } },
      }).success,
    ).toBe(false)
  })
  it('advertises each new implemented tool with the corresponding capability', () => {
    for (const tool of [...venueBotConfigurationReadTools, config, create, update]) {
      const name = 'name' in tool ? tool.name : tool.tool
      expect(OPERATOR_MCP_TOOLS.find((entry) => entry.name === name)?.capability).toBe(
        tool.capability,
      )
    }
  })
})
