import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalSupportPortableExportJson,
  SupportPortableExportPayload,
  type SupportPortableExportInput,
} from '@pathfinder/contracts'

import { readSupportPortableExport } from './support-portable-export-read'

const stamp = new Date('2026-09-12T12:00:00.000Z')

function fixture(overrides: { role?: 'STAFF' | 'MANAGER' | 'OWNER'; logo?: string } = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([
      {
        placesCount: 1n,
        knowledgeEntriesCount: 1n,
        contentHistoryVersionsCount: 0n,
        venuePackagesCount: 0n,
        publishedReportsCount: 0n,
        supportRequestsCount: 1n,
        supportMessagesCount: 1n,
        supportAttachmentsCount: 1n,
        sourceBytes: 1_000n,
      },
    ]),
    tenantMembership: {
      findFirst: vi.fn().mockResolvedValue({ role: overrides.role ?? 'MANAGER' }),
    },
    venue: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'venue-a',
        name: 'Museum',
        slug: 'museum',
        description: 'A place',
        guideNotes: 'Guide notes',
        aiGuideNotes: 'Keep answers clear.',
        aiFeaturedPlaceId: null,
        aiTone: 'FRIENDLY',
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        aiGuideName: 'Guide',
        chatTheme: 'default',
        chatAccentColor: '#123456',
        chatFont: 'jakarta',
        chatLogoUrl: overrides.logo ?? 'https://cdn.example.test/logo.png',
        chatBannerUrl: null,
        chatShowPhotos: true,
        chatShowLinks: false,
        category: 'MUSEUM',
        guideMode: 'location_aware',
        defaultCenterLat: 41,
        defaultCenterLng: -87,
        isActive: true,
        createdAt: stamp,
        updatedAt: stamp,
        venueBotConfiguration: null,
      }),
    },
    place: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'place-a',
          name: 'Gallery',
          type: 'gallery',
          itemType: 'room',
          shortDescription: 'Short',
          longDescription: 'Long',
          lat: 41,
          lng: -87,
          tags: ['art'],
          importanceScore: 10,
          areaName: 'First floor',
          hours: null,
          photoUrl: 'https://cdn.example.test/gallery.png',
          isActive: true,
          visibility: 'PUBLIC',
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    },
    venueKnowledgeEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'knowledge-a',
          title: 'Hours',
          category: 'VISIT',
          content: 'Open daily.',
          isEnabled: true,
          visibility: 'PUBLIC',
          createdAt: stamp,
          updatedAt: stamp,
        },
      ]),
    },
    contentVersion: { findMany: vi.fn().mockResolvedValue([]) },
    venuePackage: { findMany: vi.fn().mockResolvedValue([]) },
    venueReportConfiguration: { findFirst: vi.fn().mockResolvedValue({ id: 'config-a' }) },
    weeklyReport: { findMany: vi.fn().mockResolvedValue([]) },
    supportRequest: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'support-a',
          category: 'GENERAL',
          status: 'OPEN',
          subject: 'Question',
          missingInformation: [],
          requesterUserId: 'recipient-a',
          clientActivityAt: stamp,
          statusChangedAt: stamp,
          createdAt: stamp,
          participants: [],
        },
      ]),
    },
    supportMessage: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'message-a',
          supportRequestId: 'support-a',
          authorKind: 'CLIENT',
          authorId: 'recipient-a',
          body: 'Please help.',
          completionOutcome: null,
          createdAt: stamp,
        },
      ]),
    },
    supportMessageAttachment: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'attachment-a',
          supportMessageId: 'message-a',
          filename: 'details.txt',
          mediaType: 'text/plain',
          byteSize: 12n,
        },
      ]),
    },
  }
  const client = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown, options: unknown) => {
      expect(options).toEqual({ isolationLevel: 'RepeatableRead' })
      return callback(tx)
    }),
  }
  return { tx, client }
}

const input: SupportPortableExportInput = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  recipientUserId: 'recipient-a',
  sections: ['current-venue', 'recipient-support'],
}

describe('readSupportPortableExport', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns actual safe content and recipient-visible support with a verifiable hash', async () => {
    const { tx, client } = fixture()
    const result = await readSupportPortableExport(input, client as never, { now: () => stamp })

    expect(result.currentVenue?.places[0]?.longDescription).toBe('Long')
    expect(result.currentVenue?.knowledgeEntries[0]?.content).toBe('Open daily.')
    expect(result.recipientSupport?.[0]?.messages[0]).toMatchObject({
      body: 'Please help.',
      authorIsRecipient: true,
      attachments: [{ filename: 'details.txt', byteSize: '12' }],
    })
    expect(result).not.toHaveProperty('currentVenue.venue.chatLogoDerivativeReceipt')
    expect(result.recipientSupport?.[0]?.messages[0]).not.toHaveProperty('authorId')
    expect(tx.supportRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          OR: expect.any(Array),
        }),
      }),
    )
    const { contentSha256, ...payload } = result
    expect(SupportPortableExportPayload.parse(payload)).toEqual(payload)
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonicalSupportPortableExportJson(payload)),
    )
    expect(contentSha256).toBe(Buffer.from(digest).toString('hex'))
  })

  it('rejects inactive or foreign recipients before reading venue content', async () => {
    const { tx, client } = fixture()
    tx.tenantMembership.findFirst.mockResolvedValue(null)
    await expect(readSupportPortableExport(input, client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(tx.tenantMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant-a', userId: 'recipient-a', status: 'ACTIVE' },
      }),
    )
    expect(tx.venue.findFirst).not.toHaveBeenCalled()
  })

  it('does not let STAFF or support ownership widen manager-only sections', async () => {
    const { tx, client } = fixture({ role: 'STAFF' })
    await expect(
      readSupportPortableExport(
        { ...input, sections: ['content-history', 'venue-packages'] },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(tx.venue.findFirst).not.toHaveBeenCalled()
  })

  it('fails closed rather than truncating an oversized section', async () => {
    const { tx, client } = fixture()
    tx.$queryRaw.mockResolvedValue([
      {
        placesCount: 501n,
        knowledgeEntriesCount: 1n,
        contentHistoryVersionsCount: 0n,
        venuePackagesCount: 0n,
        publishedReportsCount: 0n,
        supportRequestsCount: 0n,
        supportMessagesCount: 0n,
        supportAttachmentsCount: 0n,
        sourceBytes: 1_000n,
      },
    ])
    await expect(
      readSupportPortableExport({ ...input, sections: ['current-venue'] }, client as never),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(tx.place.findMany).not.toHaveBeenCalled()
  })

  it('refuses an oversized scoped source before materializing section rows', async () => {
    const { tx, client } = fixture()
    tx.$queryRaw.mockResolvedValue([
      {
        placesCount: 1n,
        knowledgeEntriesCount: 1n,
        contentHistoryVersionsCount: 0n,
        venuePackagesCount: 0n,
        publishedReportsCount: 0n,
        supportRequestsCount: 0n,
        supportMessagesCount: 0n,
        supportAttachmentsCount: 0n,
        sourceBytes: 10_485_761n,
      },
    ])
    await expect(
      readSupportPortableExport({ ...input, sections: ['current-venue'] }, client as never),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(tx.place.findMany).not.toHaveBeenCalled()
  })

  it('omits URL locators from current content', async () => {
    const { client } = fixture({ logo: 'https://cdn.example.test/logo.png?token=private' })
    const result = await readSupportPortableExport(
      { ...input, sections: ['current-venue'] },
      client as never,
    )
    expect(result.currentVenue?.venue).not.toHaveProperty('chatLogoUrl')
    expect(result.currentVenue?.places[0]).not.toHaveProperty('photoUrl')
    expect(JSON.stringify(result)).not.toContain('token=private')
  })

  it('projects package versions one through three without URL locators', async () => {
    const { tx, client } = fixture()
    const base = {
      status: 'DRAFT',
      payloadHash: 'a'.repeat(64),
      createdAt: stamp,
      updatedAt: stamp,
      approvedAt: null,
      appliedAt: null,
      revertedAt: null,
    }
    tx.venuePackage.findMany.mockResolvedValue([
      {
        ...base,
        id: 'package-v1',
        schemaVersion: 1,
        payload: {
          schemaVersion: 1,
          places: [{ name: 'One', type: 'exhibit', photoUrl: 'https://private.example/v1.png' }],
          knowledgeEntries: [],
        },
      },
      {
        ...base,
        id: 'package-v2',
        schemaVersion: 2,
        payload: {
          schemaVersion: 2,
          venue: { branding: { chatLogoUrl: 'https://private.example/v2.png' } },
          places: [{ name: 'Two', type: 'exhibit' }],
          knowledgeEntries: [],
        },
      },
      {
        ...base,
        id: 'package-v3',
        schemaVersion: 3,
        payload: {
          schemaVersion: 3,
          places: {
            create: [
              {
                itemKey: '11111111-1111-4111-8111-111111111111',
                provenance: {
                  sourceType: 'CLIENT',
                  sourceUrl: 'https://private.example/source?token=x',
                  contentOrigin: 'HUMAN_AUTHORED',
                },
                value: {
                  name: 'Three',
                  type: 'exhibit',
                  photoUrl: 'https://private.example/v3.png',
                },
              },
            ],
            update: [],
            delete: [],
          },
          knowledgeEntries: { create: [], update: [], delete: [] },
        },
      },
    ])
    const result = await readSupportPortableExport(
      { ...input, sections: ['venue-packages'] },
      client as never,
      { now: () => stamp },
    )
    expect(result.venuePackages?.map((row) => row.schemaVersion)).toEqual([1, 2, 3])
    expect(JSON.stringify(result.venuePackages)).not.toMatch(
      /photoUrl|chatLogoUrl|sourceUrl|private\.example/,
    )
  })

  it('exports supported history snapshots without actor or URL provenance', async () => {
    const { tx, client } = fixture()
    tx.contentVersion.findMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        sequence: 1n,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        entityType: 'PLACE',
        entityId: 'place-a',
        operation: 'UPDATE',
        snapshotSchemaVersion: 2,
        beforeState: null,
        afterState: {
          id: 'place-a',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          name: 'Gallery',
          type: 'gallery',
          itemType: null,
          shortDescription: 'Before',
          longDescription: null,
          lat: null,
          lng: null,
          tags: [],
          importanceScore: 1,
          areaName: null,
          hours: null,
          photoUrl: 'https://private.example/history.png',
          isActive: true,
          sourceType: 'CLIENT',
          authorship: 'HUMAN',
          sourceName: 'Notes',
          sourceUrl: 'https://private.example/source',
          importedAt: null,
          humanConfirmedAt: stamp,
          humanConfirmedBy: 'internal-user',
          lastReviewedAt: stamp,
          lastReviewedBy: 'internal-reviewer',
          sourcePackageId: null,
        },
        createdAt: stamp,
      },
    ])
    const result = await readSupportPortableExport(
      { ...input, sections: ['content-history'] },
      client as never,
      { now: () => stamp },
    )
    expect(result.contentHistory?.[0]?.afterState).toMatchObject({
      id: 'place-a',
      shortDescription: 'Before',
      provenance: { sourceType: 'CLIENT', authorship: 'HUMAN' },
    })
    expect(JSON.stringify(result.contentHistory)).not.toMatch(
      /photoUrl|sourceUrl|internal-user|internal-reviewer/,
    )
  })

  it('rejects history snapshots whose embedded venue scope conflicts with the row', async () => {
    const { tx, client } = fixture()
    tx.contentVersion.findMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        sequence: 1n,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        entityType: 'OPERATIONAL_UPDATE',
        entityId: 'update-a',
        operation: 'CREATE',
        snapshotSchemaVersion: 1,
        beforeState: null,
        afterState: {
          id: 'update-a',
          tenantId: 'tenant-a',
          venueId: 'venue-b',
          placeId: null,
          updateType: 'GENERAL_NOTICE',
          severity: 'INFO',
          priority: 'NORMAL',
          title: 'Wrong venue',
          body: 'This snapshot must not cross the requested venue boundary.',
          redirectTo: null,
          startsAt: stamp,
          expiresAt: null,
          status: 'DRAFT',
          isActive: true,
          createdBy: 'author-a',
          publishedBy: null,
          publishedAt: null,
          createdAt: stamp,
        },
        createdAt: stamp,
      },
    ])
    await expect(
      readSupportPortableExport({ ...input, sections: ['content-history'] }, client as never, {
        now: () => stamp,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_RECORD' })
  })

  it('requires the existing public report gate and returns published text', async () => {
    const { tx, client } = fixture({ role: 'STAFF' })
    tx.weeklyReport.findMany.mockResolvedValue([
      {
        id: 'report-a',
        title: 'Week',
        weekStart: stamp,
        weekEnd: stamp,
        content: 'Published content',
        publishedAt: stamp,
      },
    ])
    const result = await readSupportPortableExport(
      { ...input, sections: ['published-reports'] },
      client as never,
      { now: () => stamp },
    )
    expect(result.publishedReports?.[0]?.content).toBe('Published content')
    expect(tx.weeklyReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'PUBLISHED' }) }),
    )
    tx.venueReportConfiguration.findFirst.mockResolvedValue(null)
    await expect(
      readSupportPortableExport({ ...input, sections: ['published-reports'] }, client as never),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
