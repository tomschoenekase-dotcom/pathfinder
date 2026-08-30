/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { previewOffboardingExportManifest: { query } } }),
}))

import { OffboardingExportManifestPreview } from './OffboardingExportManifestPreview'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('OffboardingExportManifestPreview', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('submits exact selected venues and exposes no execution controls', async () => {
    query.mockResolvedValue({
      schemaVersion: 1,
      generatedAt: '2030-01-01T00:00:00.000Z',
      tenantId: 'tenant-1',
      selectedVenueIds: ['venue-1'],
      privacyBoundary: 'METADATA_REFERENCES_ONLY',
      venues: [
        {
          id: 'venue-1',
          name: 'Museum',
          slug: 'museum',
          isActive: true,
          tonePreset: 'friendly',
          tonePresetVersion: 1,
          updatedAt: '2030-01-01T00:00:00.000Z',
        },
      ],
      currentContent: [],
      contentHistory: [],
      packages: [],
      modules: [],
      revisions: [],
      evidence: [],
      truncation: { packages: { returned: 0, available: 0, cap: 250, truncated: false } },
    })
    render(
      <OffboardingExportManifestPreview
        tenantId="tenant-1"
        venues={[{ id: 'venue-1', name: 'Museum' }]}
      />,
    )
    fireEvent.click(screen.getByLabelText('Museum'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest metadata' }))
    await waitFor(() =>
      expect(query).toHaveBeenCalledWith({ tenantId: 'tenant-1', venueIds: ['venue-1'] }),
    )
    expect(await screen.findByText(/Privacy boundary/)).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: /export|download|revoke|delete|execute/i }),
    ).toBeNull()
  })

  it('reports read failure without claiming an artifact', async () => {
    query.mockRejectedValue(new Error('unavailable'))
    render(
      <OffboardingExportManifestPreview
        tenantId="tenant-1"
        venues={[{ id: 'venue-1', name: 'Museum' }]}
      />,
    )
    fireEvent.click(screen.getByLabelText('Museum'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview manifest metadata' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('No export artifact'),
    )
  })
})
