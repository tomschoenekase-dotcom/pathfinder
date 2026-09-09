import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FamilyRigRenderer,
  type FamilyRigRendererProps,
} from '../../../packages/ui/src/character/FamilyRigRenderer'

// Capture public JSX img props at element creation, not React's private DOM/fiber fields.
// UI uses automatic JSX; this web test also supports its host's classic transform.
const images: { source: string; key: unknown; error: () => void }[] = []
function captureImage(type: unknown, props: unknown, key?: unknown) {
  const image = props as (React.ImgHTMLAttributes<HTMLImageElement> & { key?: unknown }) | null
  if (type === 'img' && image?.onError) {
    const onError = image.onError
    images.push({
      source: typeof image.src === 'string' ? image.src : '',
      key: key ?? image.key,
      error: () => onError({} as React.SyntheticEvent<HTMLImageElement>),
    })
  }
}

vi.mock('react/jsx-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-runtime')>()
  return {
    ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => {
      captureImage(args[0], args[1], args[2])
      return actual.jsx(...args)
    },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => {
      captureImage(args[0], args[1], args[2])
      return actual.jsxs(...args)
    },
  }
})

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      captureImage(args[0], args[1], args[2])
      return actual.jsxDEV(...args)
    },
  }
})

const base: FamilyRigRendererProps = {
  name: 'Neutral owl',
  source: '/whole.svg',
  fallbackSource: '/fallback.svg',
  family: 'compact-creature-v1',
  state: 'speaking',
  motion: 'system',
}

function errorFor(source: string): () => void {
  const image = [...images].reverse().find((entry) => entry.source === source)
  expect(image, `captured a real renderer callback for ${source}`).toBeDefined()
  return image!.error
}

async function invoke(...callbacks: (() => void)[]) {
  await act(async () => {
    callbacks.forEach((callback) => callback())
    await Promise.resolve()
  })
}

describe('FamilyRigRenderer current-identity lifecycle', () => {
  beforeEach(() => {
    images.length = 0
    vi.stubGlobal('React', React)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(['source', 'layer'] as const)(
    '%s errors advance once to exact static fallback, then permanently to neutral T',
    async (kind) => {
      const onAssetError = vi.fn()
      const layers =
        kind === 'layer'
          ? [
              { role: 'body', source: '/body.svg' },
              { role: 'face', source: '/face.svg' },
            ]
          : undefined
      const view = render(
        <FamilyRigRenderer {...base} layers={layers} onAssetError={onAssetError} />,
      )
      const sourceError = errorFor(layers?.[0]?.source ?? base.source)
      const otherError = kind === 'layer' ? errorFor('/face.svg') : sourceError
      await invoke(sourceError, sourceError, otherError)
      expect(onAssetError).toHaveBeenCalledTimes(1)
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(base.fallbackSource)
      expect(
        view.container.querySelector('[data-rig-motion]')?.getAttribute('data-rig-motion'),
      ).toBe('reduced')

      const fallbackError = errorFor(base.fallbackSource)
      await invoke(fallbackError, fallbackError)
      expect(onAssetError).toHaveBeenCalledTimes(2)
      const fallbackRenders = images.filter((entry) => entry.source === base.fallbackSource).length
      await invoke(sourceError, otherError, fallbackError)
      expect(view.container.querySelector('img')).toBeNull()
      expect(view.container.textContent).toBe('T')
      expect(onAssetError).toHaveBeenCalledTimes(2)
      expect(images.filter((entry) => entry.source === base.fallbackSource)).toHaveLength(
        fallbackRenders,
      )
    },
  )

  it.each(['source', 'layer', 'fallback'] as const)(
    'ignores captured old %s errors after replacement and after an A → B → A revisit',
    async (kind) => {
      const aNotify = vi.fn(),
        bNotify = vi.fn()
      const a = {
        ...base,
        layers: kind === 'layer' ? [{ role: 'body', source: '/a-layer.svg' }] : undefined,
      }
      const view = render(<FamilyRigRenderer {...a} onAssetError={aNotify} />)
      let oldError = errorFor(a.layers?.[0]?.source ?? a.source)
      if (kind === 'fallback') {
        await invoke(oldError)
        oldError = errorFor(a.fallbackSource)
      }
      const aCalls = aNotify.mock.calls.length
      const b = { ...base, source: '/b.svg', fallbackSource: '/b-fallback.svg' }
      view.rerender(<FamilyRigRenderer {...b} onAssetError={bNotify} />)
      await invoke(oldError)
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(b.source)
      expect(bNotify).not.toHaveBeenCalled()
      expect(aNotify).toHaveBeenCalledTimes(aCalls)
      const bError = errorFor(b.source)
      await invoke(bError)
      expect(bNotify).toHaveBeenCalledTimes(1)
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(b.fallbackSource)
      view.rerender(<FamilyRigRenderer {...a} onAssetError={aNotify} />)
      await invoke(oldError, bError)
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
        a.layers?.[0]?.source ?? a.source,
      )
      expect(aNotify).toHaveBeenCalledTimes(aCalls)
    },
  )

  it('drops previous failure scopes across 128 visited identities and retries every revisit', async () => {
    const notify = vi.fn()
    const view = render(<FamilyRigRenderer {...base} onAssetError={notify} />)
    const propsFor = (index: number) => ({
      ...base,
      source: `/source-${index}.svg`,
      fallbackSource: `/fallback-${index}.svg`,
    })
    for (let index = 0; index < 128; index++) {
      const props = propsFor(index)
      view.rerender(<FamilyRigRenderer {...props} onAssetError={notify} />)
      await invoke(errorFor(props.source))
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(props.fallbackSource)
    }
    for (let index = 0; index < 128; index++) {
      const props = propsFor(index)
      view.rerender(<FamilyRigRenderer {...props} onAssetError={notify} />)
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe(props.source)
    }
    expect(notify).toHaveBeenCalledTimes(128)
  })

  it.each([
    [
      { ...base, source: 'a|b', fallbackSource: 'c' },
      { ...base, source: 'a', fallbackSource: 'b|c' },
    ],
    [
      { ...base, layers: [{ role: 'body:skin', source: 'x' }] },
      { ...base, layers: [{ role: 'body', source: 'skin:x' }] },
    ],
    [
      { ...base, layers: [{ role: 'a', source: 'b|c:d' }] },
      {
        ...base,
        layers: [
          { role: 'a', source: 'b' },
          { role: 'c', source: 'd' },
        ],
      },
    ],
  ])('does not share failure state across old delimiter-collision tuples', async (a, b) => {
    const view = render(<FamilyRigRenderer {...a} />)
    await invoke(errorFor(a.layers?.[0]?.source ?? a.source))
    view.rerender(<FamilyRigRenderer {...b} />)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      b.layers?.[0]?.source ?? b.source,
    )
    expect(view.container.querySelector('[data-rig-motion]')?.getAttribute('data-rig-motion')).toBe(
      'system',
    )
  })

  it('renders formerly colliding and repeated layers with distinct React keys', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <FamilyRigRenderer
        {...base}
        layers={[
          { role: 'body:skin', source: 'x' },
          { role: 'body', source: 'skin:x' },
          { role: 'body', source: 'skin:x' },
        ]}
      />,
    )
    expect(images).toHaveLength(3)
    expect(new Set(images.map((entry) => entry.key)).size).toBe(3)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('uses the current parent callback without re-notifying a failed stage', async () => {
    const oldNotify = vi.fn(),
      currentNotify = vi.fn()
    const view = render(<FamilyRigRenderer {...base} onAssetError={oldNotify} />)
    const oldImageCallback = errorFor(base.source)
    view.rerender(<FamilyRigRenderer {...base} onAssetError={currentNotify} motion="reduced" />)
    await invoke(oldImageCallback, oldImageCallback)
    expect(oldNotify).not.toHaveBeenCalled()
    expect(currentNotify).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-rig-motion]')?.getAttribute('data-rig-motion')).toBe(
      'reduced',
    )
  })

  it('remains monotonic and notification-safe in StrictMode', async () => {
    const notify = vi.fn()
    const view = render(
      <React.StrictMode>
        <FamilyRigRenderer {...base} onAssetError={notify} />
      </React.StrictMode>,
    )
    const sourceError = errorFor(base.source)
    await invoke(sourceError, sourceError)
    await invoke(errorFor(base.fallbackSource), sourceError)
    expect(view.container.textContent).toBe('T')
    expect(notify).toHaveBeenCalledTimes(2)
    view.unmount()
    await invoke(sourceError)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})
