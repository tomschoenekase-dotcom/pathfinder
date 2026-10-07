import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

vi.mock('../processors/embed-place', () => ({ processEmbedPlaceJob: vi.fn() }))
vi.mock('../processors/embed-knowledge-entry', () => ({ processEmbedKnowledgeEntryJob: vi.fn() }))
vi.mock('./embedding-freshness', () => ({ auditEmbeddingFreshness: vi.fn() }))

import { parseVenueRefreshArgs, runVenueRefreshCommand } from './embedding-venue-refresh-cli'

const off = { EMBEDDING_DISPATCH_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv
const base = ['--tenant-id', 'tenant-a', '--venue-id', 'venue-a']
const candidate = (entityType: 'PLACE' | 'KNOWLEDGE_ENTRY', entityId: string) => ({
  entityType,
  entityId,
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  contentUpdatedAt: new Date('2026-10-07T12:00:00.000Z'),
  primaryReason: 'complete-source-mismatch' as const,
  signals: [],
  actionable: true,
})
const audit = (candidates: ReturnType<typeof candidate>[]) => ({
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  scanned: candidates.length,
  truncated: false,
  groups: [],
  actionableCandidates: candidates,
})

describe('embedding:refresh-venue arguments', () => {
  it('defaults to a read-only plan', () => {
    expect(parseVenueRefreshArgs(base, off)).toEqual({
      mode: 'plan',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
    })
  })

  it('refuses to run while the background dispatcher could also write', () => {
    expect(() => parseVenueRefreshArgs(base, {} as NodeJS.ProcessEnv)).toThrow('EMBEDDING_DISPATCH_ENABLED=false')
  })

  it('requires an explicit bound and a receipt file to apply', () => {
    expect(() => parseVenueRefreshArgs([...base, '--apply', 'yes'], off)).toThrow('--max')
    expect(() => parseVenueRefreshArgs([...base, '--apply', 'yes', '--max', '5'], off)).toThrow(
      '--receipts',
    )
    expect(() => parseVenueRefreshArgs([...base, '--max', '5'], off)).toThrow('--apply yes')
  })
})

describe('embedding:refresh-venue run', () => {
  it('plans without embedding anything', async () => {
    const place = vi.fn()
    const knowledge = vi.fn()
    const result = await runVenueRefreshCommand(
      { mode: 'plan', tenantId: 'tenant-a', venueId: 'venue-a' },
      {
        audit: vi.fn().mockResolvedValue(audit([candidate('PLACE', 'p1')])) as never,
        processors: { place, knowledge } as never,
      },
    )
    expect(result).toMatchObject({ mode: 'plan', stale: { places: 1, knowledgeEntries: 0 } })
    expect(place).not.toHaveBeenCalled()
  })

  it('embeds each stale record once and writes receipts', async () => {
    const receipts = join(mkdtempSync(join(tmpdir(), 'venue-refresh-')), 'receipts.jsonl')
    const place = vi.fn().mockResolvedValue(undefined)
    const knowledge = vi.fn().mockResolvedValue(undefined)
    const stale = [candidate('PLACE', 'p1'), candidate('KNOWLEDGE_ENTRY', 'k1')]
    const result = await runVenueRefreshCommand(
      { mode: 'apply', tenantId: 'tenant-a', venueId: 'venue-a', max: 5, receipts },
      {
        audit: vi
          .fn()
          .mockResolvedValueOnce(audit(stale))
          .mockResolvedValueOnce(audit([])) as never,
        processors: { place, knowledge } as never,
      },
    )
    expect(result).toEqual({
      mode: 'apply',
      venueId: 'venue-a',
      refreshed: 2,
      remaining: { places: 0, knowledgeEntries: 0 },
    })
    expect(place).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', placeId: 'p1', contentUpdatedAt: '2026-10-07T12:00:00.000Z' },
      expect.objectContaining({ attemptNumber: 1, maxAttempts: 1 }),
    )
    expect(knowledge).toHaveBeenCalledTimes(1)
    const lines = readFileSync(receipts, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.action)).toEqual([
      'refresh.started',
      'refresh.entity',
      'refresh.entity',
      'refresh.complete',
    ])
  })

  it('stops at the first failure without retrying', async () => {
    const receipts = join(mkdtempSync(join(tmpdir(), 'venue-refresh-')), 'receipts.jsonl')
    const place = vi.fn().mockRejectedValue(new Error('provider down'))
    const knowledge = vi.fn().mockResolvedValue(undefined)
    await expect(
      runVenueRefreshCommand(
        { mode: 'apply', tenantId: 'tenant-a', venueId: 'venue-a', max: 5, receipts },
        {
          audit: vi
            .fn()
            .mockResolvedValue(
              audit([
                candidate('PLACE', 'p1'),
                candidate('PLACE', 'p2'),
                candidate('KNOWLEDGE_ENTRY', 'k1'),
              ]),
            ) as never,
          processors: { place, knowledge } as never,
        },
      ),
    ).rejects.toThrow('stopped without retrying')
    expect(place).toHaveBeenCalledTimes(2)
    expect(knowledge).not.toHaveBeenCalled()
  })

  it('refuses when more records are stale than the bound allows', async () => {
    const receipts = join(mkdtempSync(join(tmpdir(), 'venue-refresh-')), 'receipts.jsonl')
    await expect(
      runVenueRefreshCommand(
        { mode: 'apply', tenantId: 'tenant-a', venueId: 'venue-a', max: 1, receipts },
        {
          audit: vi
            .fn()
            .mockResolvedValue(
              audit([candidate('PLACE', 'p1'), candidate('PLACE', 'p2')]),
            ) as never,
          processors: { place: vi.fn(), knowledge: vi.fn() } as never,
        },
      ),
    ).rejects.toThrow('raise --max')
  })
})
