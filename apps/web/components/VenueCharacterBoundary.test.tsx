import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ui/brand', () => ({
  PathFinderIcon: () => <span aria-hidden="true">mark</span>,
}))

import { VenueCharacterBoundary } from './VenueCharacterBoundary'

function FailedCharacter(): React.JSX.Element {
  throw new Error('character chunk failed')
}

describe('VenueCharacterBoundary', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('contains an optional renderer failure and can recover for a different pack', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = render(
      <VenueCharacterBoundary resetKey="tochi:1">
        <FailedCharacter />
      </VenueCharacterBoundary>,
    )

    expect(
      screen.getByText('The character display is unavailable. Text chat is still ready.'),
    ).toBeTruthy()

    view.rerender(
      <VenueCharacterBoundary resetKey="tochi:2">
        <p>Character recovered</p>
      </VenueCharacterBoundary>,
    )

    await waitFor(() => expect(screen.getByText('Character recovered')).toBeTruthy())
    consoleError.mockRestore()
  })
})
