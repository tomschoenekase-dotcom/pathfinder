/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { VenueQrKit } from './VenueQrKit'

describe('VenueQrKit', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

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
        venueAsset={{
          schema: 'torchiko.venue-launch-asset/1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          release: { kind: 'LEGACY', id: 'legacy:venue_1', revisionSha256: 'a'.repeat(64) },
          publicUrl: 'https://guide.example.com/museum/chat?source=qr',
          filename: 'torchiko-museum-qr.svg',
          mimeType: 'image/svg+xml',
          sizeBytes: 4,
          sha256: 'b'.repeat(64),
          contentBase64: 'PHN2Zz4=',
        }}
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
})
