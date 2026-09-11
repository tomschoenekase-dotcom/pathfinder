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

  it('renders a general code and item-prefill code without auto-sending', () => {
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
        guideItems={[{ id: 'place_1', name: 'Tide Clock', updatedAt: '2026-08-10T12:00:00.000Z' }]}
      />,
    )

    expect(screen.getByText('Museum guest guide')).toBeTruthy()
    expect(screen.getByText('Tide Clock')).toBeTruthy()
    expect(screen.getByText('https://guide.example.com/museum/chat?source=qr')).toBeTruthy()
    expect(screen.getByText(/prompt=Tell\+me\+about\+Tide\+Clock/)).toBeTruthy()
    expect(screen.getAllByTitle(/QR code for/)).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Download SVG for/ })).toHaveLength(2)
    expect(screen.getAllByText(/save this QR code for signs and handouts/i)).toHaveLength(2)
    expect(screen.getByText(/never send it automatically/i)).toBeTruthy()
  })

  it('uses the browser print dialog only after an explicit operator action', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined)
    render(
      <VenueQrKit
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
        guideItems={[]}
      />,
    )

    expect(print).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Print QR sheets' }))
    expect(print).toHaveBeenCalledOnce()
  })

  it('uses client-safe launch language without exposing admin authority', () => {
    render(
      <VenueQrKit
        audience="client"
        venueName="Museum"
        guestChatUrl="https://guide.example.com/museum/chat"
        generatedAt="2026-08-11T18:00:00.000Z"
        guideItems={[]}
      />,
    )

    expect(screen.getByText('Launch materials')).toBeTruthy()
    expect(screen.getByText(/does not change whether the visitor guide is live/i)).toBeTruthy()
    expect(screen.getByText(/scan each code before displaying it/i)).toBeTruthy()
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
        guideItems={[]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download SVG for Museum guest guide' }))
    expect(screen.getByRole('alert').textContent).toMatch(/could not be downloaded/i)
  })
})
