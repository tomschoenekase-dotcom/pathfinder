import { describe, expect, it, vi } from 'vitest'

import type { VerifiedMcpCredentialScope } from '@pathfinder/contracts/mcp-v0'

import { createPathfinderMcpRegistry, type PathfinderMcpDomainActions } from './registry'
import {
  createPathfinderMcpReadActions,
  decodeMcpReadCursor,
  encodeMcpReadCursor,
  McpReadBindingError,
  readMcpResource,
} from './read-actions'

const credential: VerifiedMcpCredentialScope = {
  credentialId: 'credential-1',
  tenantId: 'tenant-1',
  clientId: 'tenant-1',
  venueIds: ['venue-1'],
  capabilities: [
    'resources:read',
    'clients:read',
    'venues:read',
    'configuration:read',
    'content:read',
    'history:read',
    'packages:read',
    'support:read',
    'updates:read',
    'ai-usage:read',
    'jobs:read',
    'evaluations:read',
    'readiness:read',
  ],
}

function database() {
  return {
    tenant: { findFirst: vi.fn() },
    venue: { findFirst: vi.fn(), findMany: vi.fn() },
    place: { findMany: vi.fn(), count: vi.fn() },
    venueKnowledgeEntry: { findMany: vi.fn(), count: vi.fn() },
    contentVersion: { findMany: vi.fn() },
    venuePackage: { findMany: vi.fn() },
    supportRequest: { findMany: vi.fn() },
    operationalUpdate: { findMany: vi.fn() },
    aiUsageDailyRollup: { findMany: vi.fn() },
    jobRecord: { findMany: vi.fn() },
    evalRun: { findMany: vi.fn() },
    venueReportConfiguration: { findFirst: vi.fn() },
  }
}

const unavailableWrites: Omit<PathfinderMcpDomainActions, 'read'> = {
  verifyApprovalGrant: vi.fn(),
  createPackageDraft: vi.fn(),
  createUpdateDraft: vi.fn(),
  createSupportDraft: vi.fn(),
  requestEvaluation: vi.fn(),
}

describe('MCP v0 concrete read bindings', () => {
  it('binds through the registry and reapplies exact tenant/client/venue scope to safe selects', async () => {
    const db = database()
    db.place.findMany.mockResolvedValue([
      {
        id: 'place-1',
        name: 'Gallery',
        type: 'gallery',
        itemType: null,
        shortDescription: 'Open today',
        longDescription: null,
        lat: null,
        lng: null,
        tags: [],
        areaName: null,
        hours: null,
        sourceType: 'HUMAN',
        authorship: 'CLIENT',
        sourceName: null,
        lastReviewedAt: null,
        createdAt: new Date('2026-08-11T12:00:00.000Z'),
        updatedAt: new Date('2026-08-11T12:00:00.000Z'),
      },
    ])
    db.venueKnowledgeEntry.findMany.mockResolvedValue([])
    const registry = createPathfinderMcpRegistry(
      createPathfinderMcpReadActions(db as never, unavailableWrites),
    )

    const response = await registry.callTool(
      'pathfinder.read',
      { resource: 'content', clientId: 'tenant-1', venueId: 'venue-1', limit: 1 },
      { credential },
    )

    expect(response.structuredContent.data).toMatchObject({
      items: [{ id: 'place-1', contentKind: 'place' }],
      nextCursor: null,
    })
    for (const delegate of [db.place, db.venueKnowledgeEntry]) {
      expect(delegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
          take: 2,
        }),
      )
    }
    const serialized = JSON.stringify(response.structuredContent)
    expect(serialized).not.toContain('tenant-2')
    expect(serialized).not.toContain('secret')
  })

  it('denies mismatched verified tenant/client scope even when request and clientId agree', async () => {
    const db = database()
    await expect(
      readMcpResource(
        db as never,
        { resource: 'clients', clientId: 'client-alias', limit: 25 },
        { credential: { ...credential, clientId: 'client-alias' } },
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_INVARIANT' })
    expect(db.tenant.findFirst).not.toHaveBeenCalled()
  })

  it('denies cross-venue access before any database delegate is called', async () => {
    const db = database()
    await expect(
      readMcpResource(
        db as never,
        { resource: 'support', clientId: 'tenant-1', venueId: 'venue-2', limit: 25 },
        { credential },
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_INVARIANT' })
    expect(db.supportRequest.findMany).not.toHaveBeenCalled()
  })

  it('uses deterministic resource-bound cursors and rejects substitution or malformed tokens', () => {
    const cursor = encodeMcpReadCursor({
      resource: 'content',
      sortAt: '2026-08-11T12:00:00.000Z',
      id: 'place-1',
    })
    expect(cursor).toBe(
      encodeMcpReadCursor({
        resource: 'content',
        sortAt: '2026-08-11T12:00:00.000Z',
        id: 'place-1',
      }),
    )
    expect(decodeMcpReadCursor(cursor, 'content')).toMatchObject({
      resource: 'content',
      id: 'place-1',
    })
    expect(() => decodeMcpReadCursor(cursor, 'support')).toThrow(McpReadBindingError)
    expect(() => decodeMcpReadCursor('not-json', 'content')).toThrow(McpReadBindingError)
  })

  it('never selects raw content snapshots, package payloads, support artifacts, or internal messages', async () => {
    const db = database()
    db.contentVersion.findMany.mockResolvedValue([])
    db.venuePackage.findMany.mockResolvedValue([])
    db.supportRequest.findMany.mockResolvedValue([])

    for (const resource of ['history', 'packages', 'support'] as const) {
      await readMcpResource(
        db as never,
        { resource, clientId: 'tenant-1', venueId: 'venue-1', limit: 100 },
        { credential },
      )
    }

    const historySelect = db.contentVersion.findMany.mock.calls[0]![0].select
    expect(historySelect).not.toHaveProperty('beforeState')
    expect(historySelect).not.toHaveProperty('afterState')
    expect(historySelect).not.toHaveProperty('sourceProvenance')
    const packageSelect = db.venuePackage.findMany.mock.calls[0]![0].select
    expect(packageSelect).not.toHaveProperty('payload')
    expect(packageSelect).not.toHaveProperty('validationReport')
    expect(packageSelect).not.toHaveProperty('previewPlan')
    const supportSelect = db.supportRequest.findMany.mock.calls[0]![0].select
    expect(supportSelect).not.toHaveProperty('artifacts')
    expect(supportSelect).not.toHaveProperty('messages')
    expect(supportSelect).not.toHaveProperty('auditEvents')
    expect(db.contentVersion.findMany.mock.calls[0]![0].take).toBe(101)
  })

  it('never selects or returns credential-bearing content or configuration URLs', async () => {
    const db = database()
    db.place.findMany.mockResolvedValue([
      {
        id: 'place-url-test',
        name: 'Safe name',
        createdAt: new Date('2026-08-11T12:00:00.000Z'),
        updatedAt: new Date('2026-08-11T12:00:00.000Z'),
        sourceUrl: 'https://source.invalid/file?token=source-secret',
        photoUrl: 'https://media.invalid/file?X-Amz-Credential=media-secret',
      },
    ])
    db.venueKnowledgeEntry.findMany.mockResolvedValue([
      {
        id: 'knowledge-url-test',
        title: 'Safe title',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        updatedAt: new Date('2026-08-10T12:00:00.000Z'),
        sourceUrl: 'https://source.invalid/file?token=knowledge-secret',
      },
    ])
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: 'Guide',
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      isActive: true,
      updatedAt: new Date('2026-08-11T12:00:00.000Z'),
      chatLogoUrl: 'https://media.invalid/logo?token=logo-secret',
      chatBannerUrl: 'https://media.invalid/banner?X-Amz-Credential=banner-secret',
    })

    const content = await readMcpResource(
      db as never,
      { resource: 'content', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const configuration = await readMcpResource(
      db as never,
      { resource: 'configuration', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )

    for (const select of [
      db.place.findMany.mock.calls[0]![0].select,
      db.venueKnowledgeEntry.findMany.mock.calls[0]![0].select,
    ]) {
      expect(select).not.toHaveProperty('sourceUrl')
      expect(select).not.toHaveProperty('photoUrl')
    }
    const configurationSelect = db.venue.findFirst.mock.calls[0]![0].select
    expect(configurationSelect).not.toHaveProperty('chatLogoUrl')
    expect(configurationSelect).not.toHaveProperty('chatBannerUrl')
    const serialized = JSON.stringify({ content, configuration })
    expect(serialized).not.toContain('X-Amz-Credential')
    expect(serialized).not.toContain('token=')
    expect(serialized).not.toContain('source-secret')
    expect(serialized).not.toContain('media-secret')
    expect(serialized).not.toContain('logo-secret')
    expect(serialized).not.toContain('banner-secret')
  })

  it('does not select evaluation error detail', async () => {
    const db = database()
    db.evalRun.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'evaluations', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    expect(db.evalRun.findMany.mock.calls[0]![0].select).not.toHaveProperty('lastErrorCode')
  })

  it('uses an exact venue predicate for jobs without selecting payload or error fields', async () => {
    const db = database()
    db.jobRecord.findMany.mockResolvedValue([])
    await readMcpResource(
      db as never,
      { resource: 'jobs', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    const query = db.jobRecord.findMany.mock.calls[0]![0]
    expect(query.where).toMatchObject({
      tenantId: 'tenant-1',
      payload: { path: ['venueId'], equals: 'venue-1' },
    })
    expect(query.select).not.toHaveProperty('payload')
    expect(query.select).not.toHaveProperty('error')
  })

  it('returns only derived readiness evidence and never configuration blobs', async () => {
    const db = database()
    db.venue.findFirst.mockResolvedValue({
      id: 'venue-1',
      name: 'Museum',
      slug: 'museum',
      isActive: true,
      updatedAt: new Date('2026-08-11T12:00:00.000Z'),
    })
    db.place.count.mockResolvedValue(2)
    db.venueKnowledgeEntry.count.mockResolvedValue(3)
    db.venueReportConfiguration.findFirst.mockResolvedValue({ enabled: false })

    const response = await readMcpResource(
      db as never,
      { resource: 'readiness', clientId: 'tenant-1', venueId: 'venue-1', limit: 25 },
      { credential },
    )
    expect(response.data).toMatchObject({
      venueId: 'venue-1',
      activePlaceCount: 2,
      enabledKnowledgeCount: 3,
      readyForPreview: true,
    })
    expect(db.venue.findFirst.mock.calls[0]![0].select).not.toHaveProperty('config')
  })
})
