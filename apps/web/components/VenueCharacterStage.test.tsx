import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicCharacterProjection } from '@pathfinder/contracts/character-system'

vi.mock('@pathfinder/ui/character', () => ({
  PublicCharacterPresence: ({
    state,
    onAssetError,
  }: {
    state: string
    onAssetError?: () => void
  }) => (
    <div>
      <span>Visual state: {state}</span>
      <button type="button" onClick={onAssetError}>
        Simulate asset failure
      </button>
    </div>
  ),
}))

import { VenueCharacterStage } from './VenueCharacterStage'

const projection: PublicCharacterProjection = {
  characterId: 'tochi',
  displayName: 'Tochi',
  assetPackId: 'tochi-approved',
  assetPackVersion: '1.0.0',
  renderer: 'static-image-v1',
  publicBasePath: '/characters/tochi/1.0.0',
  assets: [
    {
      id: 'fallback',
      path: 'fallback.svg',
      mediaType: 'image/svg+xml',
      width: 128,
      height: 128,
      bytes: 512,
    },
  ],
  canvas: { width: 128, height: 128 },
  anchors: { lookAt: { x: 64, y: 52 }, embers: { x: 64, y: 18 } },
  staticFallbackAssetId: 'fallback',
  reducedMotionFallbackAssetId: 'fallback',
  layers: {},
  states: {},
  stateFallbacks: {},
  supportedContexts: ['venue-text-chat'],
}

describe('VenueCharacterStage', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the character bounded beside truthful text status and the empty-state greeting', () => {
    const { container, rerender } = render(
      <VenueCharacterStage
        projection={projection}
        state="thinking"
        displayName="Museum Tochi"
        greeting="Ask me anything about your visit."
        expanded
        motion="reduced"
      />,
    )

    const stage = container.querySelector('[data-character-state="thinking"]')
    expect(stage?.getAttribute('data-character-layout')).toBe('expanded')
    expect(screen.getByText('Museum Tochi')).toBeTruthy()
    expect(screen.getByText('Thinking')).toBeTruthy()
    expect(screen.getByText('Ask me anything about your visit.')).toBeTruthy()

    rerender(
      <VenueCharacterStage
        projection={projection}
        state="idle"
        displayName={null}
        greeting="Ask me anything about your visit."
        expanded={false}
      />,
    )

    expect(container.querySelector('[data-character-layout="compact"]')).toBeTruthy()
    expect(screen.queryByText('Ask me anything about your visit.')).toBeNull()
    expect(screen.getByText('Ready to help')).toBeTruthy()
  })

  it('reports an asset failure without removing the surrounding stage', () => {
    const view = render(
      <VenueCharacterStage
        projection={projection}
        state="thinking"
        displayName={null}
        greeting={null}
        expanded={false}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Simulate asset failure' }))
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('Character display unavailable; text chat is ready')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(screen.getByText('Tochi')).toBeTruthy()

    view.rerender(
      <VenueCharacterStage
        projection={{ ...projection, assetPackVersion: '1.0.1' }}
        state="idle"
        displayName={null}
        greeting={null}
        expanded={false}
      />,
    )
    expect(screen.getByText('Ready to help')).toBeTruthy()
  })
})
