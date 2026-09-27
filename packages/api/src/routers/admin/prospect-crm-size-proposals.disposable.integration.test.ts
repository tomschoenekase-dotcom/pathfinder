import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmSizeProposalsRouter } from './prospect-crm-size-proposals'

const run = process.env.RUN_PROSPECT_SIZE_DB_INTEGRATION === '1' ? describe : describe.skip
const testRouter = router({ crm: adminProspectCrmSizeProposalsRouter })

function context(): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'packet7-disposable-human',
      activeTenantId: null,
      role: null,
      isPlatformAdmin: true,
    },
  }
}

run('size proposal review and apply on disposable CRM database', () => {
  it('uploads, diffs, holds conflicts, applies selected evidence with an audit, and reads back', async () => {
    const suffix = randomUUID()
    const organizationId = `packet7-org-${suffix}`
    const venueId = `packet7-venue-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.prospectOrganization.create({
        data: {
          id: organizationId,
          canonicalName: 'Chicago History Museum',
          normalizedName: 'chicago history museum',
          createdBy: 'packet7-disposable-human',
          updatedBy: 'packet7-disposable-human',
        },
      })
      await db.prospectVenue.create({
        data: {
          id: venueId,
          organizationId,
          name: 'Chicago History Museum',
          normalizedName: 'chicago history museum',
          city: 'Chicago',
          region: 'IL',
          createdBy: 'packet7-disposable-human',
          updatedBy: 'packet7-disposable-human',
        },
      })
    })
    const caller = testRouter.createCaller(context()).crm
    const proposal = {
      schema: 'torchiko.prospect-size-proposals/v1' as const,
      status: 'proposal-only' as const,
      records: [
        {
          venueId,
          organizationId,
          snapshotName: 'Chicago History Museum',
          snapshotCity: 'Chicago',
          snapshotRegion: 'IL',
          expectedUpdatedAt: null,
          size: {
            class: 'S' as const,
            basis: 'category_rule' as const,
            sourceUrl: 'https://example.org/test-museum',
            observedAt: '2026-09-27',
            confidence: 'rule' as const,
          },
        },
      ],
    }
    const preview = await caller.previewProspectSizeProposals({ proposalFile: proposal })
    expect(preview.rows).toHaveLength(1)
    expect(preview.rows[0]).toMatchObject({
      status: 'READY',
      currentSize: null,
      snapshotCity: 'Chicago',
    })
    const version = preview.rows[0]!.currentUpdatedAt!

    await withTenantIsolationBypass(() =>
      db.prospectVenue.update({ where: { id: venueId }, data: { city: 'Evanston' } }),
    )
    const stale = await caller.applyProspectSizeProposals({
      rows: [{ ...proposal.records[0]!, expectedUpdatedAt: version }],
    })
    expect(stale.results[0]).toMatchObject({ status: 'CONFLICT' })
    expect(stale.results[0]!.reasons).toContain('City changed')
    const locationConflict = await caller.previewProspectSizeProposals({ proposalFile: proposal })
    expect(locationConflict.rows[0]).toMatchObject({
      status: 'CONFLICT',
      reasons: ['City changed'],
    })

    await withTenantIsolationBypass(() =>
      db.prospectVenue.update({ where: { id: venueId }, data: { city: 'Chicago' } }),
    )
    const ready = await caller.previewProspectSizeProposals({ proposalFile: proposal })
    expect(ready.rows[0]!.status).toBe('READY')
    const applied = await caller.applyProspectSizeProposals({
      rows: [{ ...proposal.records[0]!, expectedUpdatedAt: ready.rows[0]!.currentUpdatedAt! }],
    })
    expect(applied.results[0]).toMatchObject({ status: 'APPLIED', readbackSize: 'S' })
    const staleVersion = await caller.applyProspectSizeProposals({
      rows: [{ ...proposal.records[0]!, expectedUpdatedAt: ready.rows[0]!.currentUpdatedAt! }],
    })
    expect(staleVersion.results[0]).toMatchObject({ status: 'CONFLICT' })
    expect(staleVersion.results[0]!.reasons).toContain('Row version changed')

    const readback = await withTenantIsolationBypass(() =>
      db.prospectVenue.findUniqueOrThrow({
        where: { id: venueId },
        select: { estimatedSize: true, fitAttributes: true },
      }),
    )
    expect(readback.estimatedSize).toBe('S')
    expect(readback.fitAttributes).toMatchObject({ torchikoSizeV1: proposal.records[0]!.size })
    const audits = await withTenantIsolationBypass(() =>
      db.auditLog.count({
        where: { action: 'admin.prospect-size-proposal.applied', targetId: venueId },
      }),
    )
    expect(audits).toBe(1)
  })
})
