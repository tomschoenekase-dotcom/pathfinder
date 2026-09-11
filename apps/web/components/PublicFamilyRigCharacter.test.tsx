import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PublicCharacterProjectionSchema,
  type PublicCharacterProjection,
} from '@pathfinder/contracts/character-system'
import {
  CharacterRuntimePackSchema,
  createPublicFamilyRig,
} from '@pathfinder/contracts/character-runtime-pack'
import { PublicCharacterPresence, useCharacterController } from '@pathfinder/ui/character'

import { FamilyRigPublicAdapter } from '../../../packages/ui/src/character/FamilyRigPublicAdapter'

function projection(): PublicCharacterProjection {
  const pack = CharacterRuntimePackSchema.parse({
    schemaVersion: 1,
    renderer: 'family-rig-v1',
    characterId: 'museum-guide',
    characterVersion: 3,
    sourceSha256: 'a'.repeat(64),
    family: 'compact-creature-v1',
    capability: 'rigid-source',
    assets: [
      {
        id: 'source',
        path: 'source.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'b'.repeat(64),
      },
      {
        id: 'fallback',
        path: 'fallback.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'c'.repeat(64),
      },
      {
        id: 'reduced',
        path: 'reduced.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'd'.repeat(64),
      },
      {
        id: 'body',
        path: 'layers/body.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'e'.repeat(64),
      },
      {
        id: 'wing',
        path: 'layers/wing.svg',
        mediaType: 'image/svg+xml',
        width: 320,
        height: 360,
        bytes: 100,
        sha256: 'f'.repeat(64),
      },
    ],
    canvas: { width: 320, height: 360 },
    safeBounds: { x: 8, y: 8, width: 304, height: 344 },
    origin: { x: 160, y: 340 },
    anchors: { lookAt: { x: 160, y: 140 }, embers: { x: 160, y: 320 } },
    sourceAssetId: 'source',
    staticFallbackAssetId: 'fallback',
    reducedMotionFallbackAssetId: 'reduced',
    layers: [
      { role: 'body', assetId: 'body' },
      { role: 'wing', assetId: 'wing' },
    ],
    supportedStates: ['idle', 'speaking'],
    stateFallbacks: {
      attention: 'idle',
      listening: 'idle',
      thinking: 'idle',
      success: 'idle',
      processing: 'idle',
      uploadReceiving: 'idle',
      uploadComplete: 'idle',
      question: 'idle',
      handoff: 'idle',
      error: 'idle',
      sleeping: 'idle',
      minimized: 'idle',
    },
    supportedContexts: ['venue-text-chat'],
  })
  return PublicCharacterProjectionSchema.parse({
    characterId: pack.characterId,
    displayName: 'Museum Guide',
    assetPackId: 'museum-guide-v3',
    assetPackVersion: '3.0.0',
    renderer: pack.renderer,
    familyRig: createPublicFamilyRig(pack),
    publicBasePath: '/characters/custom/museum-guide-v3',
    assets: pack.assets.map(({ id, path, mediaType, width, height, bytes }) => ({
      id,
      path,
      mediaType,
      width,
      height,
      bytes,
    })),
    canvas: pack.canvas,
    anchors: pack.anchors,
    staticFallbackAssetId: pack.staticFallbackAssetId,
    reducedMotionFallbackAssetId: pack.reducedMotionFallbackAssetId,
    layers: {},
    states: {
      idle: { variant: 'idle' },
      speaking: { variant: 'speaking' },
    },
    stateFallbacks: pack.stateFallbacks,
    supportedContexts: pack.supportedContexts,
  })
}

let imageNaturalWidth: (image: HTMLImageElement) => number

beforeEach(() => {
  imageNaturalWidth = () => 72
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return imageNaturalWidth(this)
  })
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockImplementation(function (
    this: HTMLImageElement,
  ) {
    return imageNaturalWidth(this)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('published family-rig character', () => {
  it('renders declared layers in order, resolves semantic fallback, and preserves canvas sizing', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    const { rerender } = render(
      <PublicCharacterPresence
        projection={projection()}
        state="question"
        context="venue-text-chat"
        motion="full"
        size="compact"
      />,
    )

    expect(screen.getByRole('img', { name: 'Museum Guide: idle' })).toBeTruthy()
    const frame = document.querySelector('[data-character-family-frame="compact"]') as HTMLElement
    expect(frame.style.aspectRatio).toBe('320 / 360')
    expect(
      [...document.querySelectorAll<HTMLImageElement>('[data-rig-layer]')].map((image) => [
        image.dataset.rigLayer,
        image.getAttribute('src'),
      ]),
    ).toEqual([
      ['body', '/characters/custom/museum-guide-v3/layers/body.svg'],
      ['wing', '/characters/custom/museum-guide-v3/layers/wing.svg'],
    ])

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    rerender(
      <PublicCharacterPresence
        projection={projection()}
        state="speaking"
        context="venue-text-chat"
        motion="full"
        size="stage"
      />,
    )
    expect(document.querySelector('[data-character-family-frame="stage"]')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Museum Guide: speaking' })).toBeTruthy()
  })

  it('uses the exact approved reduced-motion fallback for explicit reduced motion', () => {
    render(
      <PublicCharacterPresence
        projection={projection()}
        state="speaking"
        context="venue-text-chat"
        motion="reduced"
      />,
    )
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(
      (document.querySelector('[data-character-fallback="pack"]') as HTMLElement).style.aspectRatio,
    ).toBe('320 / 360')
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      '/characters/custom/museum-guide-v3/reduced.svg',
    )
  })

  it('turns a system reduced-motion preference into the approved static fallback', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
    function ControlledPresence() {
      const controller = useCharacterController({ motion: 'system', initialState: 'speaking' })
      return (
        <PublicCharacterPresence
          projection={projection()}
          state={controller.state}
          context="venue-text-chat"
          motion={controller.motion}
        />
      )
    }
    render(<ControlledPresence />)
    await waitFor(() =>
      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        '/characters/custom/museum-guide-v3/reduced.svg',
      ),
    )
  })

  it('falls back once late layer loading fails and reports a failed fallback without looping', async () => {
    const onAssetError = vi.fn()
    render(
      <PublicCharacterPresence
        projection={projection()}
        state="speaking"
        context="venue-text-chat"
        motion="full"
        onAssetError={onAssetError}
      />,
    )

    fireEvent.error(document.querySelector<HTMLImageElement>('[data-rig-layer="body"]')!)
    await waitFor(() =>
      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        '/characters/custom/museum-guide-v3/fallback.svg',
      ),
    )
    expect(onAssetError).toHaveBeenCalledTimes(1)
    fireEvent.error(document.querySelector('img')!)
    await waitFor(() => expect(screen.getByText('T')).toBeTruthy())
    expect(onAssetError).toHaveBeenCalledTimes(2)
    expect(onAssetError).toHaveBeenLastCalledWith({
      code: 'layer-load-failed',
      message: 'Character museum-guide could not load its verified family assets.',
    })
  })

  it('recovers a layer that already failed before hydration through the approved static fallback', async () => {
    imageNaturalWidth = (image) => (image.src.includes('/layers/') ? 0 : 72)
    const onAssetError = vi.fn()

    render(
      <PublicCharacterPresence
        projection={projection()}
        state="speaking"
        context="venue-text-chat"
        motion="full"
        onAssetError={onAssetError}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        '/characters/custom/museum-guide-v3/fallback.svg',
      ),
    )
    expect(document.querySelector('[data-character-family-frame]')).toBeNull()
    expect(onAssetError).toHaveBeenCalledTimes(1)
    expect(onAssetError).toHaveBeenLastCalledWith({
      code: 'layer-load-failed',
      message: 'Character museum-guide could not load its verified family assets.',
    })
  })

  it('recovers an already failed static fallback to the neutral brand without repeating callbacks', async () => {
    imageNaturalWidth = () => 0
    const onAssetError = vi.fn()

    render(
      <PublicCharacterPresence
        projection={projection()}
        state="speaking"
        context="venue-text-chat"
        motion="full"
        onAssetError={onAssetError}
      />,
    )

    await waitFor(() => expect(screen.getByText('Torchiko')).toBeTruthy())
    expect(document.querySelector('[data-character-fallback="brand"]')).toBeTruthy()
    expect(onAssetError.mock.calls.map(([error]) => error.code)).toEqual([
      'layer-load-failed',
      'static-load-failed',
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onAssetError).toHaveBeenCalledTimes(2)
  })

  it('ignores a retired static fallback error after a replacement identity renders', () => {
    const onAssetError = vi.fn()
    const firstProjection = projection()
    const secondProjection = {
      ...projection(),
      assetPackId: 'museum-guide-v4',
      assetPackVersion: '4.0.0',
      publicBasePath: '/characters/custom/museum-guide-v4',
    }
    const { rerender } = render(
      <PublicCharacterPresence
        projection={firstProjection}
        state="speaking"
        context="venue-text-chat"
        motion="reduced"
        onAssetError={onAssetError}
      />,
    )
    const retiredImage = document.querySelector('img')!

    rerender(
      <PublicCharacterPresence
        projection={secondProjection}
        state="speaking"
        context="venue-text-chat"
        motion="reduced"
        onAssetError={onAssetError}
      />,
    )
    fireEvent.error(retiredImage)

    expect(onAssetError).not.toHaveBeenCalled()
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      '/characters/custom/museum-guide-v4/reduced.svg',
    )
  })

  it('reports an invalid asset mapping after render without an unstable callback loop', async () => {
    const invalidProjection = {
      ...projection(),
      assets: projection().assets.filter((asset) => asset.id !== 'body'),
    } as PublicCharacterProjection

    function Owner() {
      const [failures, setFailures] = useState(0)
      return (
        <>
          <output data-failure-count>{failures}</output>
          <FamilyRigPublicAdapter
            projection={invalidProjection}
            state="idle"
            motion="full"
            onAssetError={() => setFailures((current) => current + 1)}
          />
        </>
      )
    }

    render(<Owner />)
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
    expect(document.querySelector('[data-character-family-frame]')).toBeNull()
  })
})
