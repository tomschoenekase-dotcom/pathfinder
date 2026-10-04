import { describe, expect, it, vi } from 'vitest'

import { recordSourceConnectionDiagnostic } from './source-connection-diagnostics'

const now = new Date('2026-10-03T20:00:00Z')
const base = { tenantId: 'tenant_a', venueId: 'venue_a', connectorId: 'conn_a', now }

function client(count = 1) {
  const updateMany = vi.fn(async () => ({ count }))
  return { updateMany, db: { liveDataConnector: { updateMany } } as never }
}

describe('recordSourceConnectionDiagnostic', () => {
  it('scopes by tenant, venue, connector and provider and writes only error fields', async () => {
    const c = client()
    const next = new Date(now.getTime() + 60_000)
    await expect(
      recordSourceConnectionDiagnostic(
        { ...base, errorCategory: 'invalid_config', nextPollAt: next },
        c.db,
      ),
    ).resolves.toBe(true)
    expect(c.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'conn_a',
        tenantId: 'tenant_a',
        venueId: 'venue_a',
        provider: 'source_connection_v1',
      },
      data: {
        lastErrorAt: now,
        lastErrorCategory: 'invalid_config',
        consecutiveFailures: { increment: 1 },
        nextPollAt: next,
      },
    })
  })

  it('surfaces preview failures in the last-test fields without a retry time', async () => {
    const c = client()
    await recordSourceConnectionDiagnostic(
      { ...base, errorCategory: 'origin_invalid', preview: true, nextPollAt: now },
      c.db,
    )
    const data = (c.updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data
    expect(data).toMatchObject({
      lastTestOutcome: 'FAILED',
      lastTestErrorCategory: 'origin_invalid',
    })
    expect(data).not.toHaveProperty('nextPollAt')
    expect(data).not.toHaveProperty('mapping')
    expect(data).not.toHaveProperty('state')
  })

  it('refuses unscoped ids and free-text categories without writing', async () => {
    const c = client()
    await expect(
      recordSourceConnectionDiagnostic({ ...base, tenantId: '', errorCategory: 'x' }, c.db),
    ).resolves.toBe(false)
    await expect(
      recordSourceConnectionDiagnostic(
        { ...base, errorCategory: 'https://secret.example/path?token=1' },
        c.db,
      ),
    ).resolves.toBe(false)
    expect(c.updateMany).not.toHaveBeenCalled()
  })

  it('reports false when no scoped connector matched', async () => {
    await expect(
      recordSourceConnectionDiagnostic({ ...base, errorCategory: 'internal_error' }, client(0).db),
    ).resolves.toBe(false)
  })
})
