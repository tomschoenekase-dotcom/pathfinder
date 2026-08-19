import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VenueCharacterFallback } from './VenueCharacterFallback'

describe('VenueCharacterFallback', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('distinguishes a pending lazy renderer from a real renderer failure', () => {
    const { rerender } = render(<VenueCharacterFallback status="loading" />)

    expect(screen.getByRole('status').textContent).toContain('Character is getting ready')
    expect(screen.queryByText(/unavailable/i)).toBeNull()

    rerender(<VenueCharacterFallback status="unavailable" compact />)

    expect(screen.getByRole('status').textContent).toContain('display is unavailable')
    expect(screen.getByRole('status').textContent).toContain('Text chat is still ready')
  })
})
