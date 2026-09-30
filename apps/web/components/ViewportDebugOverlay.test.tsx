import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ViewportDebugOverlay } from './ViewportDebugOverlay'

describe('ViewportDebugOverlay', () => {
  afterEach(() => {
    cleanup()
    window.history.replaceState(null, '', '/')
  })

  it('renders nothing unless ?debugViewport=1 is present', () => {
    vi.stubGlobal('React', React)
    const { container } = render(<ViewportDebugOverlay />)
    expect(container.querySelector('[data-viewport-debug]')).toBeNull()
  })

  it('shows the geometry readout when enabled', async () => {
    vi.stubGlobal('React', React)
    window.history.replaceState(null, '', '/?debugViewport=1')
    const { container } = render(<ViewportDebugOverlay />)
    const readout = container.querySelector('[data-viewport-debug]')
    expect(readout?.textContent).toContain('innerHeight')
    expect(readout?.textContent).toContain('keyboard-open unset')
  })
})
