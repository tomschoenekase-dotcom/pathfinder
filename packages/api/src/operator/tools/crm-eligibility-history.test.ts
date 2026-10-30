import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ load: vi.fn(), require: vi.fn() }))
vi.mock('@pathfinder/db', async (original) => ({
  ...(await original<typeof import('@pathfinder/db')>()),
  loadProspectOutreachHistory: mocks.load,
  requireProspectOutreachHistory: mocks.require,
}))
import { ProspectOutreachHistoryError } from '@pathfinder/db'
import { outreachEligibilityForRead } from './crm-eligibility'
import type { OperatorCallContext } from '../registry'
const history = {
  canonicalOrganizationId: 'org-fiction',
  organizationIds: ['org-fiction'],
  coldEmailCount: null,
  lastColdEmailAt: null,
  firstHumanReply: 'otherUnknown',
  relationship: 'prospect',
  nextEligibleAt: null,
  eligibility: 'hold',
  eligibilityReason: 'history_incomplete',
  reasons: ['history_incomplete'],
  contactHealth: 'healthy',
  historyComplete: false,
}
const context = {
  database: {
    prospectOrganization: {
      findUnique: vi.fn(async () => ({
        id: 'org-fiction',
        conversion: null,
        customerRelationships: [],
      })),
    },
  },
  grant: { allTenants: true, tenantIds: [] },
  now: new Date('2026-10-30T12:00:00Z'),
} as unknown as OperatorCallContext
beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(history)
})
describe('read flags share canonical outreach gates', () => {
  it('holds cold drafting despite a healthy address and excludes only its own current draft', async () => {
    const result = await outreachEligibilityForRead(context, {
      organizationId: 'org-fiction',
      contactId: 'contact-fiction',
      excludeDraftId: 'draft-current',
      snapshot: { outreachKind: 'cold' },
    })
    expect(result.allowed).toBe(false)
    expect(result.reasons).toEqual(['history_incomplete'])
    expect(mocks.load).toHaveBeenCalledWith(context.database, 'org-fiction', {
      now: context.now,
      contactId: 'contact-fiction',
      excludeDraftId: 'draft-current',
    })
  })
  it('requires the actual warm anchor gate rather than using cold cadence as warm authority', async () => {
    mocks.load.mockResolvedValue({
      ...history,
      relationship: 'inConversation',
      eligibilityReason: 'inConversation',
      reasons: ['inConversation'],
    })
    mocks.require.mockRejectedValueOnce(
      new ProspectOutreachHistoryError('warm source anchor missing'),
    )
    expect(
      (
        await outreachEligibilityForRead(context, {
          organizationId: 'org-fiction',
          contactId: 'contact-fiction',
          snapshot: { outreachKind: 'warm' },
        })
      ).allowed,
    ).toBe(false)
    mocks.require.mockResolvedValueOnce({ ...history, relationship: 'inConversation' })
    expect(
      (
        await outreachEligibilityForRead(context, {
          organizationId: 'org-fiction',
          contactId: 'contact-fiction',
          snapshot: {
            outreachKind: 'warm',
            warmReplyAnchor: { messageId: 'human-fiction', fingerprint: 'a'.repeat(64) },
          },
        })
      ).allowed,
    ).toBe(true)
  })
  it('never reports legacy unknown intent as eligible', async () => {
    mocks.load.mockResolvedValue({
      ...history,
      eligibility: 'eligible',
      reasons: [],
      historyComplete: true,
      coldEmailCount: 0,
    })
    mocks.require.mockRejectedValueOnce(
      new ProspectOutreachHistoryError('explicit intent required'),
    )
    const result = await outreachEligibilityForRead(context, {
      organizationId: 'org-fiction',
      contactId: 'contact-fiction',
      snapshot: {},
    })
    expect(result.allowed).toBe(false)
    expect(result.reasons).toEqual(['outreach_intent_unknown'])
  })
})
