import { describe, expect, it, vi } from 'vitest'
import {
  SourceConnectionConfigSchema,
  type SourceConnectionRecord,
  type SourceConnectionSnapshot,
} from '@pathfinder/contracts/source-connections'
import {
  sourceConnectionConfigHash,
  sourceConnectionSnapshotHash,
} from '@pathfinder/contracts/source-connections-node'
import { sourceConnectionPreviewHash } from './source-connections'
import { publishSourceConnectionSnapshot } from './source-connection-publication'

const now = new Date('2026-10-03T20:00:00Z')
const scope = {
  tenantId: 'tenant_fixture',
  venueId: 'venue_fixture',
  connectorId: 'connector_fixture',
}
const record: SourceConnectionRecord = {
  id: 'record_fixture',
  kind: 'description',
  title: 'Fixture description',
  text: 'An approved description.',
  sourceUrl: 'https://source.example.org/feed',
  startDate: null,
  endDate: null,
  showtimes: [],
  effectiveFrom: null,
  effectiveUntil: null,
  timezone: 'America/Chicago',
  cancelled: false,
  exceptions: [],
  links: [],
}
function harness(
  policy: 'review_required' | 'auto_verified' = 'auto_verified',
  records = [record],
) {
  const config = SourceConnectionConfigSchema.parse({
    version: 1,
    sourceUrl: record.sourceUrl,
    allowedUrls: [record.sourceUrl],
    mappings: [
      {
        type: 'json_feed',
        kind: 'description',
        itemsPointer: '/items',
        idPointer: '/id',
        titlePointer: '/title',
        textPointer: '/text',
        dateFormat: 'iso',
      },
    ],
    timezone: record.timezone,
    refreshIntervalSeconds: 300,
    freshnessSeconds: 3600,
    validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.25, maxRequestsPerDay: 2 },
    publicationPolicy: policy,
  })
  const configHash = sourceConnectionConfigHash(config)
  const contentHash = sourceConnectionSnapshotHash(records)
  const previewBody = {
    configHash,
    contentHash,
    records,
    issues: [],
    status: 'VALID' as const,
    observedAt: now.toISOString(),
    cost: { fetches: 1, bytes: 42 },
  }
  const preview = {
    ...previewBody,
    previewId: 'preview_fixture',
    previewHash: sourceConnectionPreviewHash(previewBody),
  }
  config.approval = {
    approvedConfigHash: configHash,
    approvedPreviewHash: preview.previewHash,
    approvedAt: now.toISOString(),
    approvedBy: 'human_fixture',
  }
  const snapshot = {
    version: 1 as const,
    configHash,
    contentHash,
    records,
    sourceUrl: record.sourceUrl,
    observedAt: now.toISOString(),
    freshnessExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    validUntil: null,
    cost: { fetches: 1, bytes: 42 },
  }
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    liveDataConnector: {
      findFirst: vi.fn().mockResolvedValue({
        mapping: config,
        endpointUrl: record.sourceUrl,
        lastTestPreview: preview,
        updatedAt: now,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venueWebsiteOrigin: {
      findMany: vi.fn().mockResolvedValue([{ origin: 'https://source.example.org' }]),
    },
    liveDataObservation: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({ id: 'observation_fixture' }),
    },
    venueKnowledgeEntry: {
      findFirst: vi.fn(async ({ where }) =>
        where.contentPublicationId ? { id: 'knowledge_fixture' } : null,
      ),
      create: vi.fn().mockResolvedValue({ id: 'knowledge_fixture' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    contentModuleIdentity: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'module_fixture' }),
    },
    contentModuleRevision: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'revision_fixture' }),
    },
    operationalFactContent: { create: vi.fn().mockResolvedValue({ id: 'fact_fixture' }) },
    contentModuleEvidence: { create: vi.fn().mockResolvedValue({ id: 'evidence_fixture' }) },
    contentModulePublication: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'publication_fixture' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_fixture' }) },
    venueSource: { create: vi.fn().mockResolvedValue({ id: 'source_evidence_fixture' }) },
    venueSourceInput: { create: vi.fn().mockResolvedValue({ id: 'source_input_fixture' }) },
  }
  const client = {
    ...tx,
    $transaction: vi.fn(async (fn: (transaction: typeof tx) => unknown) => fn(tx)),
  }
  const former = {
    recordId: record.id,
    moduleId: 'module_fixture',
    revisionId: 'revision_fixture',
    publicationId: 'publication_fixture',
    knowledgeEntryId: 'knowledge_fixture',
  }
  const old: SourceConnectionSnapshot = { ...snapshot, publicationIds: [former] }
  const useOld = (overrides: Partial<SourceConnectionSnapshot> = {}) => {
    tx.liveDataObservation.findFirst.mockResolvedValue({
      values: { ...old, ...overrides },
    } as never)
    tx.venueKnowledgeEntry.findFirst.mockResolvedValue({
      id: former.knowledgeEntryId,
      title: record.title,
      content: record.text,
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: scope.connectorId,
      contentRevisionId: former.revisionId,
      contentPublicationId: former.publicationId,
    } as never)
    tx.contentModulePublication.findFirst.mockResolvedValue({
      id: former.publicationId,
      revisionId: former.revisionId,
      action: 'PUBLISH',
      actorId: `source-connection:${scope.connectorId}`,
    } as never)
    tx.contentModuleRevision.findFirst.mockResolvedValue({
      id: former.revisionId,
      version: 1,
    } as never)
  }
  return { tx, client: client as never, config, snapshot, preview, old, former, useOld }
}

describe('approved source publication', () => {
  it('creates typed content, immutable evidence, projection and system audit in one transaction', async () => {
    const h = harness()
    const result = await publishSourceConnectionSnapshot(
      { ...scope, snapshot: h.snapshot, now },
      h.client,
    )
    expect(result.status).toBe('PUBLISHED')
    expect(result.snapshot?.publicationIds).toHaveLength(1)
    expect(h.tx.contentModuleEvidence.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceId: 'source_evidence_fixture',
          tenantId: scope.tenantId,
          venueId: scope.venueId,
        }),
      }),
    )
    expect(h.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorType: 'SYSTEM',
          actorRole: 'WORKER',
          action: 'source_connection.published',
        }),
      }),
    )
    expect(h.tx.venueSourceInput.create).toHaveBeenCalledTimes(1)
  })
  it('rejects any invalid record before creating even the first revision or evidence', async () => {
    const bad = {
      ...record,
      id: 'forbidden_fixture',
      sourceUrl: 'https://forbidden.example.org/page',
    }
    const h = harness('auto_verified', [record, bad])
    expect(
      (await publishSourceConnectionSnapshot({ ...scope, snapshot: h.snapshot, now }, h.client))
        .status,
    ).toBe('CONFLICT')
    expect(h.tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(h.tx.venueSource.create).not.toHaveBeenCalled()
  })
  it('fences pause/config races before writing any content', async () => {
    const h = harness()
    h.tx.liveDataConnector.updateMany.mockResolvedValue({ count: 0 })
    expect(
      (await publishSourceConnectionSnapshot({ ...scope, snapshot: h.snapshot, now }, h.client))
        .status,
    ).toBe('CONFLICT')
    expect(h.tx.venueKnowledgeEntry.create).not.toHaveBeenCalled()
    expect(h.tx.venueSource.create).not.toHaveBeenCalled()
  })
  it('does not create another revision or publication when a valid snapshot is unchanged', async () => {
    const h = harness()
    h.useOld()
    const result = await publishSourceConnectionSnapshot(
      { ...scope, snapshot: h.snapshot, now },
      h.client,
    )
    expect(result.status).toBe('UNCHANGED')
    expect(result.snapshot?.publicationIds).toEqual([h.former])
    expect(h.tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(h.tx.contentModulePublication.create).not.toHaveBeenCalled()
  })
  it('allows an exact newly approved preview after a config change even under review_required', async () => {
    const h = harness('review_required')
    h.useOld({
      configHash: 'a'.repeat(64),
      contentHash: sourceConnectionSnapshotHash([{ ...record, text: 'Earlier description.' }]),
      records: [{ ...record, text: 'Earlier description.' }],
    })
    h.tx.venueKnowledgeEntry.findFirst.mockResolvedValue({
      id: h.former.knowledgeEntryId,
      title: record.title,
      content: 'Earlier description.',
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: scope.connectorId,
      contentRevisionId: h.former.revisionId,
      contentPublicationId: h.former.publicationId,
    } as never)
    expect(
      (await publishSourceConnectionSnapshot({ ...scope, snapshot: h.snapshot, now }, h.client))
        .status,
    ).toBe('PUBLISHED')
    expect(h.tx.contentModuleRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 2 }) }),
    )
    expect(h.tx.venueKnowledgeEntry.updateMany).not.toHaveBeenCalled()
  })
  it('holds unapproved drift and large record changes without mutations', async () => {
    const h = harness()
    h.useOld()
    h.config.approval!.approvedPreviewHash = 'b'.repeat(64)
    const records = [{ ...record, text: 'Changed description.' }]
    expect(
      (
        await publishSourceConnectionSnapshot(
          {
            ...scope,
            now,
            snapshot: {
              ...h.snapshot,
              records,
              contentHash: sourceConnectionSnapshotHash(records),
            },
          },
          h.client,
        )
      ).status,
    ).toBe('CONFLICT')
    expect(h.tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(h.tx.venueSourceInput.create).not.toHaveBeenCalled()
  })
  it('preserves human publication projections and withholds their source reference', async () => {
    const h = harness()
    h.useOld()
    h.tx.venueKnowledgeEntry.findFirst.mockResolvedValue({
      id: h.former.knowledgeEntryId,
      title: 'Manual title',
      content: 'Human replacement.',
      sourceType: 'UNIVERSAL_CONTENT',
      sourceName: scope.connectorId,
      contentRevisionId: h.former.revisionId,
      contentPublicationId: h.former.publicationId,
    } as never)
    const result = await publishSourceConnectionSnapshot(
      { ...scope, snapshot: h.snapshot, now },
      h.client,
    )
    expect(result.snapshot?.publicationIds).toEqual([])
    expect(h.tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(h.tx.venueKnowledgeEntry.updateMany).not.toHaveBeenCalled()
    expect(h.tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'source_connection.manual_override_preserved' }),
      }),
    )
  })
  it('does not overwrite a newer manual revision or a changed publication head', async () => {
    const h = harness()
    h.useOld()
    h.tx.contentModulePublication.findFirst.mockResolvedValue({
      id: 'human_publication',
      revisionId: 'human_revision',
      action: 'PUBLISH',
      actorId: `source-connection:${scope.connectorId}`,
    } as never)
    expect(
      (await publishSourceConnectionSnapshot({ ...scope, snapshot: h.snapshot, now }, h.client))
        .snapshot?.publicationIds,
    ).toEqual([])
    expect(h.tx.contentModuleRevision.create).not.toHaveBeenCalled()
    expect(h.tx.venueKnowledgeEntry.updateMany).not.toHaveBeenCalled()
  })
})
