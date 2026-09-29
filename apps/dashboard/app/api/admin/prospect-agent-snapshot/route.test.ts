import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    auditLog: { create: vi.fn() },
    prospectOrganization: { findMany: vi.fn() },
    prospectEmailMessage: { groupBy: vi.fn() },
    prospectEmailThread: { groupBy: vi.fn() },
    prospectOutreachDraft: { groupBy: vi.fn() },
    prospectCampaignMember: { findMany: vi.fn() },
    prospectDuplicateCandidate: { findMany: vi.fn() },
    prospectActivity: { groupBy: vi.fn() },
  },
}))

vi.mock('@pathfinder/auth/server', () => ({ auth: mocks.auth }))
vi.mock('@pathfinder/db', () => ({ db: mocks.db }))

import { GET } from './route'

const adminSession = {
  userId: 'user_admin',
  sessionClaims: { publicMetadata: { platform_role: 'PLATFORM_ADMIN' } },
}

function organizationRow(id: string, email: string, doNotContact = false) {
  return {
    id,
    canonicalName: `Sample Venue ${id}`,
    website: null,
    organizationType: 'museum',
    headquartersCity: 'Sampleton',
    headquartersRegion: 'IL',
    headquartersCountry: 'US',
    relationshipTier: 'STANDARD',
    notes: null,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    opportunity: null,
    venues: [],
    contacts: [
      {
        id: `${id}-contact`,
        venueId: null,
        fullName: null,
        title: null,
        email,
        phone: null,
        emailReadiness: 'VALID',
        permissionState: 'UNKNOWN',
        doNotContact,
        suppressionReason: null,
        suppressedAt: null,
        unsubscribedAt: null,
        complainedAt: null,
        lastHardBounceAt: null,
      },
    ],
    tagAssignments: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const model of Object.values(mocks.db)) {
    for (const fn of Object.values(model)) fn.mockResolvedValue([])
  }
  mocks.db.auditLog.create.mockResolvedValue({})
})

describe('GET /api/admin/prospect-agent-snapshot', () => {
  it('rejects a signed-out request without reading the CRM', async () => {
    mocks.auth.mockResolvedValue({ userId: null, sessionClaims: null })
    const response = await GET()
    expect(response.status).toBe(401)
    expect(mocks.db.prospectOrganization.findMany).not.toHaveBeenCalled()
  })

  it('rejects a signed-in non-admin without reading the CRM or auditing', async () => {
    mocks.auth.mockResolvedValue({ userId: 'user_member', sessionClaims: { publicMetadata: {} } })
    const response = await GET()
    expect(response.status).toBe(403)
    expect(mocks.db.prospectOrganization.findMany).not.toHaveBeenCalled()
    expect(mocks.db.auditLog.create).not.toHaveBeenCalled()
  })

  it('streams a parseable, paginated snapshot and audits the download', async () => {
    mocks.auth.mockResolvedValue(adminSession)
    mocks.db.prospectOrganization.findMany
      .mockResolvedValueOnce([
        organizationRow('a', 'open@example.com'),
        organizationRow('b', 'blocked@example.com', true),
      ])
      .mockResolvedValueOnce([organizationRow('c', 'third@example.com')])
      .mockResolvedValueOnce([])
    mocks.db.prospectEmailMessage.groupBy.mockResolvedValue([
      {
        organizationId: 'a',
        direction: 'OUTBOUND',
        _count: { _all: 2 },
        _max: { occurredAt: new Date('2026-09-10T00:00:00Z') },
      },
    ])
    mocks.db.prospectDuplicateCandidate.findMany.mockResolvedValue([
      { organizationAId: 'c', organizationBId: 'z', status: 'OPEN' },
    ])

    const response = await GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="torchiko-crm-snapshot-.+\.json"$/u,
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')

    const text = await response.text()
    const snapshot = JSON.parse(text)
    expect(snapshot).toMatchObject({ schemaVersion: 1, readOnly: true })
    expect(snapshot.counts).toEqual({
      organizations: 3,
      venues: 0,
      contacts: 3,
      suppressedContacts: 1,
    })
    expect(snapshot.organizations.map((org: { id: string }) => org.id)).toEqual(['a', 'b', 'c'])
    expect(snapshot.organizations[0].outreach).toMatchObject({
      everContacted: true,
      outboundMessages: 2,
    })
    expect(snapshot.organizations[2].outreach.duplicateReview).toBe('OPEN')
    expect(text).not.toContain('blocked@example.com')

    expect(mocks.db.prospectOrganization.findMany.mock.calls[1]![0]).toMatchObject({
      cursor: { id: 'b' },
      skip: 1,
    })
    expect(mocks.db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'user_admin',
        action: 'admin.prospect-agent-snapshot.downloaded',
        targetId: snapshot.snapshotId,
      }),
    })
  })

  it('returns a valid empty snapshot when the CRM has no organizations', async () => {
    mocks.auth.mockResolvedValue(adminSession)
    const snapshot = JSON.parse(await (await GET()).text())
    expect(snapshot.organizations).toEqual([])
    expect(snapshot.counts.organizations).toBe(0)
  })
})
