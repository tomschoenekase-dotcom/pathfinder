/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  portalQuery: vi.fn(),
  adminQuery: vi.fn(),
}))
vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    portal: { getVenueLaunchAsset: { query: mocks.portalQuery } },
    admin: { getVenueLaunchAsset: { query: mocks.adminQuery } },
  }),
}))

import { VenueQrKit } from './VenueQrKit'

describe('VenueQrKit', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    mocks.portalQuery.mockReset()
    mocks.adminQuery.mockReset()
  })

  const venueAsset = {
    schema: 'torchiko.venue-launch-asset/1' as const,
    tenantId: 'tenant_1',
    venueId: 'venue_1',
    release: { kind: 'NATIVE' as const, id: 'release_1', revisionSha256: 'a'.repeat(64) },
    publicUrl: 'https://guide.example.com/museum/chat?source=qr',
    filename: 'torchiko-museum-qr.svg',
    mimeType: 'image/svg+xml' as const,
    sizeBytes: 4,
    sha256: 'b'.repeat(64),
    contentBase64: 'PHN2Zz4=',
  }

  it('renders exactly one primary venue code', () => {
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
      />,
    )

    expect(screen.getByText('Museum visitor guide')).toBeTruthy()
    expect(screen.queryByText('Tide Clock')).toBeNull()
    expect(screen.getByText('https://guide.example.com/museum/chat?source=qr')).toBeTruthy()
    expect(screen.queryByText(/prompt=Tell\+me\+about\+Tide\+Clock/)).toBeNull()
    expect(screen.getAllByTitle(/QR code for/)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Download SVG for/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Download PNG for/ })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Download PDF for/ })).toHaveLength(1)
    expect(screen.getAllByText(/save this QR code for signs and handouts/i)).toHaveLength(1)
  })

  it('uses the browser print dialog only after an explicit operator action', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
      />,
    )

    expect(print).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Print QR code' }))
    expect(print).toHaveBeenCalledOnce()
  })

  it('shows the bound source revision for the venue code', () => {
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-09-22T00:00:00.000Z"
        venueAsset={{ ...venueAsset, release: { ...venueAsset.release, kind: 'LEGACY' } }}
      />,
    )
    expect(screen.getByText('Content revision: legacy aaaaaaaaaaaa')).toBeTruthy()
    expect(screen.getByText('https://guide.example.com/museum/chat?source=qr')).toBeTruthy()
  })

  it('uses client-safe launch language without exposing admin authority', () => {
    render(
      <VenueQrKit
        audience="client"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
      />,
    )

    expect(screen.getByText('Visitor access')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Museum QR code' })).toBeTruthy()
    expect(screen.getByText(/use this one code/i)).toBeTruthy()
    expect(screen.getByText(/scan the code once/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Print QR code' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/generated|content revision/iu)
    expect(document.body.textContent).not.toMatch(/internal|approve|publish|rate limit|incident/iu)
  })

  it('shows an accessible recovery message when SVG export fails', () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:qr',
    })
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('download unavailable')
    })
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download SVG for Museum visitor guide' }))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be downloaded/i)
  })

  it('downloads exact server PNG bytes for the bound client venue and release', async () => {
    const pngBase64 = btoa('server png bytes')
    mocks.portalQuery.mockResolvedValue({
      ...venueAsset,
      schema: 'torchiko.venue-launch-asset/2',
      format: 'PNG',
      generatorVersion: 'qr-print-v1',
      filename: 'museum.png',
      mimeType: 'image/png',
      sizeBytes: atob(pngBase64).length,
      contentBase64: pngBase64,
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:server-qr'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    const downloadedNames: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedNames.push(this.download)
    })

    render(
      <VenueQrKit
        audience="client"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
        venueAsset={venueAsset}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Download PNG for/ }))
    await vi.waitFor(() => expect(click).toHaveBeenCalledOnce())

    expect(mocks.portalQuery).toHaveBeenCalledWith(
      { venueId: 'venue_1', format: 'PNG' },
      { signal: expect.any(AbortSignal) },
    )
    expect(mocks.adminQuery).not.toHaveBeenCalled()
    const downloadedBlob = createObjectURL.mock.calls[0]![0] as Blob
    expect(downloadedBlob.type).toBe('image/png')
    expect(downloadedBlob.size).toBe(atob(pngBase64).length)
    const reader = new FileReader()
    const downloadedBytes = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(atob(String(reader.result).split(',')[1] ?? ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(downloadedBlob)
    })
    expect(downloadedBytes).toBe('server png bytes')
    expect(downloadedNames).toEqual(['museum.png'])
  })

  it('rejects a server PDF from a different published release', async () => {
    mocks.adminQuery.mockResolvedValue({
      ...venueAsset,
      schema: 'torchiko.venue-launch-asset/2',
      format: 'PDF',
      generatorVersion: 'qr-print-v1',
      filename: 'museum.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      contentBase64: 'cGRmIQ==',
      release: { ...venueAsset.release, id: 'release_other' },
    })

    render(
      <VenueQrKit
        audience="admin"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
        venueAsset={venueAsset}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Download PDF for/ }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/try again/i)
    expect(mocks.adminQuery).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', venueId: 'venue_1', format: 'PDF' },
      { signal: expect.any(AbortSignal) },
    )
  })
})
