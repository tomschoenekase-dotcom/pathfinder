import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicCharacterProjection } from '@pathfinder/contracts/character-system'

const observed = vi.hoisted(() => ({
  callbacks: [] as (() => void)[],
  commits: [] as { characterId: string; version: string; status: string | null | undefined }[],
}))

vi.mock('@pathfinder/ui/character', () => ({
  PublicCharacterPresence: ({
    state,
    projection,
    onAssetError,
  }: {
    state: string
    projection: PublicCharacterProjection
    onAssetError?: () => void
  }) => {
    if (onAssetError) observed.callbacks.push(onAssetError)
    React.useLayoutEffect(() => {
      observed.commits.push({
        characterId: projection.characterId,
        version: projection.assetPackVersion,
        status: document.querySelector('[role="status"]')?.textContent,
      })
    })
    return (
      <div>
        <span>Visual state: {state}</span>
        <button type="button" onClick={onAssetError}>
          Simulate asset failure
        </button>
      </div>
    )
  },
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
  beforeEach(() => {
    vi.stubGlobal('React', React)
    observed.callbacks.length = 0
    observed.commits.length = 0
  })
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

  it.each([
    { assetPackVersion: '1.0.1' },
    { assetPackId: 'replacement-pack' },
    { characterId: 'another-character' },
  ])('isolates a replacement projection at its first commit: %j', async (replacement) => {
    const stage = (value: PublicCharacterProjection) => (
      <VenueCharacterStage
        projection={value}
        state="idle"
        displayName={null}
        greeting={null}
        expanded={false}
      />
    )
    const view = render(stage(projection))
    const oldError = observed.callbacks[0]!
    await act(async () => {
      oldError()
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toContain('text chat is ready')

    observed.commits.length = 0
    view.rerender(stage({ ...projection, ...replacement }))
    // The child's layout-effect observation occurs before any passive reset effect.
    expect(observed.commits[0]?.status).toBe('Ready to help')
    const currentError = observed.callbacks[observed.callbacks.length - 1]!
    expect(currentError).not.toBe(oldError)
    await act(async () => {
      oldError()
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe('Ready to help')

    await act(async () => {
      currentError()
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe(
      'Character display unavailable; text chat is ready',
    )

    // Returning to A is a new scope, not permission for A's original callback to run.
    view.rerender(stage(projection))
    await act(async () => {
      oldError()
      currentError()
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe('Ready to help')
  })

  it('does not conflate projections whose contract strings contain separators', async () => {
    const a = { ...projection, characterId: 'a|b', assetPackId: 'c' }
    const b = { ...projection, characterId: 'a', assetPackId: 'b|c' }
    const props = { state: 'idle' as const, displayName: null, greeting: null, expanded: false }
    const view = render(<VenueCharacterStage {...props} projection={a} />)
    const oldError = observed.callbacks[0]!
    await act(async () => {
      oldError()
      await Promise.resolve()
    })
    view.rerender(<VenueCharacterStage {...props} projection={b} />)
    await act(async () => {
      oldError()
      await Promise.resolve()
    })
    expect(screen.getByRole('status').textContent).toBe('Ready to help')
  })

  it('keeps the callback stable across semantic updates and duplicate current-pack errors', async () => {
    const props = { projection, displayName: null, greeting: null, expanded: false }
    const view = render(<VenueCharacterStage {...props} state="idle" />)
    const error = observed.callbacks[0]!
    view.rerender(<VenueCharacterStage {...props} state="thinking" />)
    expect(observed.callbacks[observed.callbacks.length - 1]).toBe(error)
    await act(async () => {
      error()
      error()
      await Promise.resolve()
    })
    expect(observed.callbacks[observed.callbacks.length - 1]).toBe(error)
    expect(screen.getByRole('status').textContent).toBe(
      'Character display unavailable; text chat is ready',
    )
  })
})
