/* @vitest-environment jsdom */

import { randomUUID } from 'node:crypto'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../../../packages/api/src/core'
import type { TRPCContext } from '../../../../packages/api/src/context'
import { adminProspectCrmSizeProposalsRouter } from '../../../../packages/api/src/routers/admin/prospect-crm-size-proposals'

const mock = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mock.client }))

import { ProspectSizeProposalReview } from './ProspectSizeProposalReview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const run = process.env.RUN_PROSPECT_SIZE_DB_INTEGRATION === '1' ? it : it.skip
const testRouter = router({ admin: adminProspectCrmSizeProposalsRouter })

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

afterEach(() => cleanup())

run(
  'uploads a proposal in the screen and applies it through the real disposable CRM writer',
  async () => {
    const suffix = randomUUID()
    const organizationId = `packet7-ui-org-${suffix}`
    const venueId = `packet7-ui-venue-${suffix}`
    await withTenantIsolationBypass(async () => {
      await db.prospectOrganization.create({
        data: {
          id: organizationId,
          canonicalName: 'Synthetic History House',
          normalizedName: 'synthetic history house',
          createdBy: 'packet7-disposable-human',
          updatedBy: 'packet7-disposable-human',
        },
      })
      await db.prospectVenue.create({
        data: {
          id: venueId,
          organizationId,
          name: 'Synthetic History House',
          normalizedName: 'synthetic history house',
          city: 'Chicago',
          region: 'IL',
          createdBy: 'packet7-disposable-human',
          updatedBy: 'packet7-disposable-human',
        },
      })
    })

    const caller = testRouter.createCaller(context()).admin
    mock.client = {
      admin: {
        previewProspectSizeProposals: {
          mutate: (input: Parameters<typeof caller.previewProspectSizeProposals>[0]) =>
            caller.previewProspectSizeProposals(input),
        },
        applyProspectSizeProposals: {
          mutate: (input: Parameters<typeof caller.applyProspectSizeProposals>[0]) =>
            caller.applyProspectSizeProposals(input),
        },
      },
    }

    try {
      const body = JSON.stringify({
        schema: 'torchiko.prospect-size-proposals/v1',
        status: 'proposal-only',
        records: [
          {
            venueId,
            organizationId,
            snapshotName: 'Synthetic History House',
            snapshotCity: 'Chicago',
            snapshotRegion: 'IL',
            expectedUpdatedAt: null,
            size: {
              class: 'S',
              basis: 'category_rule',
              sourceUrl: 'https://example.org/synthetic-history-house',
              observedAt: '2026-09-27',
              confidence: 'rule',
            },
          },
        ],
      })
      const file = new File([body], 'packet7-ui.json', { type: 'application/json' })
      Object.defineProperty(file, 'text', { value: async () => body })

      render(<ProspectSizeProposalReview />)
      fireEvent.change(screen.getByLabelText('Choose a size proposal JSON file'), {
        target: { files: [file] },
      })
      await screen.findByText(/1 records in packet7-ui.json/)
      fireEvent.click(screen.getByRole('button', { name: 'Preview rows' }))
      expect(await screen.findByText('Ready')).toBeTruthy()
      expect(screen.getByText('Synthetic History House')).toBeTruthy()
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Synthetic History House' }))
      fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }))
      expect(await screen.findByText('Read back: S')).toBeTruthy()
      const row = await withTenantIsolationBypass(() =>
        db.prospectVenue.findUniqueOrThrow({
          where: { id: venueId },
          select: { estimatedSize: true, fitAttributes: true },
        }),
      )
      expect(row.estimatedSize).toBe('S')
      expect(row.fitAttributes).toMatchObject({ torchikoSizeV1: { class: 'S' } })
      await waitFor(() =>
        expect(screen.getByRole('status').textContent).toMatch(/applied and read back/),
      )
    } finally {
      await withTenantIsolationBypass(async () => {
        await db.auditLog.deleteMany({
          where: { targetId: venueId, action: 'admin.prospect-size-proposal.applied' },
        })
        await db.prospectVenue.deleteMany({ where: { id: venueId } })
        await db.prospectOrganization.deleteMany({ where: { id: organizationId } })
      })
    }
  },
)
