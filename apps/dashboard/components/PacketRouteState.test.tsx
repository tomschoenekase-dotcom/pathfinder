// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PacketRouteError, PacketRouteLoading } from './PacketRouteState'

describe('Packet 2 route states', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('announces a reduced-motion-compatible busy state', () => {
    render(<PacketRouteLoading label="offboarding plans" />)
    const state = screen.getByRole('status', { name: 'Loading offboarding plans' })
    expect(state.getAttribute('aria-busy')).toBe('true')
    expect(state.querySelector('.motion-reduce\\:animate-none')).toBeTruthy()
  })

  it('focuses an honest failure heading and exposes a keyboard reset control', async () => {
    const reset = vi.fn()
    render(
      <PacketRouteError
        title="Offboarding plans unavailable"
        detail="No operation was attempted."
        reset={reset}
      />,
    )
    const heading = screen.getByRole('heading', { name: 'Offboarding plans unavailable' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    fireEvent.click(screen.getByRole('button', { name: 'Try loading again' }))
    expect(reset).toHaveBeenCalledOnce()
  })
})
