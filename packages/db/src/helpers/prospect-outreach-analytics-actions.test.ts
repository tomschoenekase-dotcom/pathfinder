import { describe, expect, it, vi } from 'vitest'

import { getProspectOutreachAnalyticsAction } from './prospect-outreach-analytics-actions'

describe('prospect outreach analytics', () => {
  it('reports outcome, safety, follow-up, draft, research, and contact quality without opens', async () => {
    const grouped = (rows: unknown[]) => vi.fn().mockResolvedValue(rows)
    const client = {
      prospectSendItem: {
        groupBy: grouped([
          { status: 'DELIVERED', _count: { _all: 7 } },
          { status: 'COMPLAINED', _count: { _all: 1 } },
        ]),
      },
      prospectEmailMessage: {
        groupBy: grouped([{ direction: 'INBOUND', _count: { _all: 3 } }]),
      },
      prospectOpportunity: {
        groupBy: grouped([
          { stage: 'QUALIFIED', _count: { _all: 2 } },
          { stage: 'WON', _count: { _all: 1 } },
        ]),
      },
      prospectContact: {
        groupBy: grouped([
          { permissionState: 'OPTED_OUT', _count: { _all: 1 } },
          { emailReadiness: 'VALID', _count: { _all: 8 } },
        ]),
      },
      prospectFollowup: {
        groupBy: grouped([{ status: 'COMPLETED', _count: { _all: 2 } }]),
      },
      prospectOutreachDraft: {
        groupBy: grouped([{ status: 'APPROVED', _count: { _all: 7 } }]),
      },
      prospectResearchJob: {
        groupBy: grouped([{ status: 'RESEARCHED', _count: { _all: 9 } }]),
      },
      companyMeeting: { count: vi.fn().mockResolvedValue(2) },
    }
    const result = await getProspectOutreachAnalyticsAction(
      { campaignId: 'campaign-1' },
      client as never,
    )
    expect(result).toMatchObject({
      replies: 3,
      meetings: 2,
      conversions: 1,
      qualified: 2,
      optOuts: 1,
      complaints: 1,
      followups: { COMPLETED: 2 },
      draftQuality: { APPROVED: 7 },
      researchQuality: { RESEARCHED: 9 },
    })
    expect(JSON.stringify(result)).not.toMatch(/open/iu)
  })
})
