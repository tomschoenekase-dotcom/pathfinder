import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ getClientVenue: vi.fn(), getVenueLaunchAsset: vi.fn() }))
vi.mock('../../../../../../../../lib/admin-caller', () => ({
  createAdminCaller: vi.fn(async () => ({ admin: mocks })),
}))

import AdminVenueQrKitPage from './page'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a' }
const asset = {
  schema: 'torchiko.venue-launch-asset/1' as const,
  tenantId: scope.tenantId,
  venueId: scope.venueId,
  release: { kind: 'LEGACY' as const, id: 'legacy:venue-a', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://guide.example.com/museum/chat?source=qr',
  filename: 'torchiko-museum-qr.svg',
  mimeType: 'image/svg+xml' as const,
  sizeBytes: 4,
  sha256: 'b'.repeat(64),
  contentBase64: 'PHN2Zz4=',
}

async function renderPage() {
  return renderToStaticMarkup(await AdminVenueQrKitPage({ params: Promise.resolve(scope) }))
}

describe('internal workspace QR launch kit route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_WEB_URL = 'https://guide.example.com'
    mocks.getClientVenue.mockResolvedValue({
      venue: { id: scope.venueId, name: 'Museum', slug: 'museum' },
      places: [{ id: 'staff', name: 'Private staff entrance', isActive: true }],
    })
    mocks.getVenueLaunchAsset.mockResolvedValue(asset)
  })

  it('renders the exact current venue QR while withholding private place names', async () => {
    const html = await renderPage()
    expect(mocks.getClientVenue).toHaveBeenCalledWith(scope)
    expect(mocks.getVenueLaunchAsset).toHaveBeenCalledWith(scope)
    expect(html).toContain('Museum visitor guide')
    expect(html).toContain(asset.publicUrl.replaceAll('&', '&amp;'))
    expect(html).toContain('Content revision: legacy aaaaaaaaaaaa')
    expect(html).toContain('Print QR sheets')
    expect(html).not.toContain('Private staff entrance')
  })

  it('renders no code when the current public source is unavailable', async () => {
    mocks.getVenueLaunchAsset.mockResolvedValue(null)
    const html = await renderPage()
    expect(html).toContain('QR kit is not available')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('Private staff entrance')
  })

  it('provides a recoverable error when the source read fails', async () => {
    mocks.getVenueLaunchAsset.mockRejectedValue(new Error('read unavailable'))
    const html = await renderPage()
    expect(html).toContain('QR kit could not be loaded')
    expect(html).toContain('retry')
    expect(html).not.toContain('<svg')
  })
})
