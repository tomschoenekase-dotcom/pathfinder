import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildPlaceActionMessage,
  DEFAULT_PLACE_ACTION_LABEL,
  normalizeBridgeOrigins,
  parseHostAsk,
  parseHostPlace,
  parseHostPrefill,
  parseHostStartParams,
  parseHostToGuideMessage,
  parsePlaceActionLabel,
} from './host-bridge'
import { postPlaceActionToNativeHost, useHostBridge } from './use-host-bridge'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('host bridge input boundaries', () => {
  it('bounds and normalizes unsent ask and venue place input', () => {
    expect(parseHostStartParams({ ask: '  Find the   map  ', place: ' public-1 ' })).toEqual({
      ask: 'Find the map',
      place: 'public-1',
    })
    expect(parseHostAsk('a'.repeat(201))).toBeUndefined()
    expect(parseHostAsk('a'.repeat(200))).toHaveLength(200)
    expect(parseHostAsk('one\ntwo')).toBeUndefined()
    expect(parseHostPlace('p'.repeat(192))).toBeUndefined()
    expect(parseHostPlace('x\u0000y')).toBeUndefined()
    expect(parseHostStartParams({ ask: ['one', 'two'], place: undefined })).toEqual({
      ask: undefined,
      place: undefined,
    })
  })

  it('rejects malformed, oversized, unsupported, and extra-key host messages', () => {
    const valid = { source: 'torchiko', v: 1, type: 'prefill', payload: { ask: 'Where?' } }
    expect(parseHostToGuideMessage(valid)).toEqual(valid)
    for (const value of [
      { ...valid, v: 2 },
      { ...valid, source: 'other' },
      { ...valid, extra: true },
      { ...valid, type: 'send' },
      { ...valid, payload: { ask: 'a'.repeat(201) } },
      { ...valid, payload: { ask: 'Hi', message: 'secret' } },
      { ...valid, payload: { ask: 'a'.repeat(1100) } },
      { source: 'torchiko', v: 1, type: 'open' },
    ])
      expect(parseHostToGuideMessage(value)).toBeNull()
    expect(
      parseHostToGuideMessage({ source: 'torchiko', v: 1, type: 'open', payload: null })?.type,
    ).toBe('open')
    expect(parseHostPrefill({ place: ' public-1 ' })).toEqual({ place: 'public-1' })
  })

  it('keeps exact HTTPS origins only', () => {
    expect(normalizeBridgeOrigins(['https://venue.example', 'https://venue.example/'])).toEqual([
      'https://venue.example',
    ])
    for (const origin of [
      'http://venue.example',
      'https://venue.example/path',
      'https://venue.example@evil.example',
    ]) {
      expect(normalizeBridgeOrigins([origin])).toEqual([])
    }
  })
})

function BridgeProbe({ onPlace }: { onPlace: (value: string) => void }) {
  const bridge = useHostBridge({
    presentation: 'embed',
    allowedOrigins: ['https://venue.example'],
    onPlace,
  })
  return (
    <div ref={bridge.shellRef}>
      <span>{bridge.prefill?.ask ?? 'empty'}</span>
      <span>{bridge.hostOpen ? 'visible' : 'hidden'}</span>
    </div>
  )
}

describe('website bridge', () => {
  it('emits ready after listener setup and accepts only exact admitted parent messages', () => {
    const parent = { postMessage: vi.fn() } as unknown as Window
    vi.stubGlobal('parent', parent)
    const onPlace = vi.fn()
    render(<BridgeProbe onPlace={onPlace} />)
    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: 'torchiko', v: 1, type: 'ready', payload: null },
      'https://venue.example',
    )
    const message = {
      source: 'torchiko',
      v: 1,
      type: 'prefill',
      payload: { ask: 'Where?', place: 'public-1' },
    }
    window.dispatchEvent(
      new MessageEvent('message', {
        source: parent,
        origin: 'https://evil.example',
        data: message,
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: 'https://venue.example',
        data: message,
      }),
    )
    expect(screen.getByText('empty')).toBeTruthy()
    expect(onPlace).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: parent,
          origin: 'https://venue.example',
          data: message,
        }),
      )
    })
    expect(screen.getByText('Where?')).toBeTruthy()
    expect(onPlace).toHaveBeenCalledWith('public-1')
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: parent,
          origin: 'https://venue.example',
          data: { source: 'torchiko', v: 1, type: 'close', payload: null },
        }),
      )
    })
    expect(screen.getByText('hidden')).toBeTruthy()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: parent,
          origin: 'https://venue.example',
          data: { source: 'torchiko', v: 1, type: 'open', payload: null },
        }),
      )
    })
    expect(screen.getByText('visible')).toBeTruthy()
  })
})

function AppBridgeProbe() {
  const bridge = useHostBridge({ presentation: 'webview' })
  return (
    <button type="button" onClick={bridge.requestClose}>
      Close
    </button>
  )
}

describe('app bridge', () => {
  it('emits lifecycle and native close requests without visitor content', () => {
    const postMessage = vi.fn()
    vi.stubGlobal('ReactNativeWebView', { postMessage })
    render(<AppBridgeProbe />)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(postMessage.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
      { source: 'torchiko', v: 1, type: 'ready', payload: null },
      { source: 'torchiko', v: 1, type: 'open', payload: null },
      { source: 'torchiko', v: 1, type: 'close-requested', payload: null },
    ])
  })

  it('accepts only a same-document prefill injected by the native host', () => {
    const onPlace = vi.fn()
    function AppPrefillProbe() {
      const bridge = useHostBridge({ presentation: 'webview', onPlace })
      return <span>{bridge.prefill?.ask ?? 'empty'}</span>
    }
    render(<AppPrefillProbe />)
    const prefill = {
      source: 'torchiko',
      v: 1,
      type: 'prefill',
      payload: { ask: 'What is at the aquarium?', place: 'place-1' },
    }
    const origin = window.location.origin
    const rejected: MessageEventInit<unknown>[] = [
      { source: window, origin: 'https://evil.example', data: prefill },
      { source: null, origin, data: prefill },
      { source: window, origin, data: { ...prefill, type: 'close', payload: null } },
      { source: window, origin, data: { ...prefill, payload: { ask: 'a'.repeat(201) } } },
    ]
    for (const event of rejected)
      act(() => {
        window.dispatchEvent(new MessageEvent('message', event))
      })
    expect(screen.getByText('empty')).toBeTruthy()
    expect(onPlace).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: window, origin, data: prefill }))
    })
    expect(screen.getByText('What is at the aquarium?')).toBeTruthy()
    expect(onPlace).toHaveBeenCalledWith('place-1')
  })
})

describe('app place action', () => {
  it('accepts only a short, single-line, partner-chosen label', () => {
    expect(parsePlaceActionLabel('1')).toBe(DEFAULT_PLACE_ACTION_LABEL)
    expect(parsePlaceActionLabel('true')).toBe(DEFAULT_PLACE_ACTION_LABEL)
    expect(parsePlaceActionLabel('  Open   in our app ')).toBe('Open in our app')
    expect(parsePlaceActionLabel('a'.repeat(32))).toHaveLength(32)
    for (const value of [
      undefined,
      '',
      '   ',
      'a'.repeat(33),
      'Open\nnow',
      'Open\u0000',
      'Open \u202eppa',
      ['Open', 'Again'],
    ])
      expect(parsePlaceActionLabel(value)).toBeUndefined()
  })

  it('builds a message holding only the public place ID and name', () => {
    expect(buildPlaceActionMessage({ id: ' place-1 ', name: '  Sky   Deck ' })).toEqual({
      source: 'torchiko',
      v: 1,
      type: 'place-action',
      payload: { placeId: 'place-1', name: 'Sky Deck' },
    })
    expect(buildPlaceActionMessage({ id: '', name: 'Sky Deck' })).toBeNull()
    expect(buildPlaceActionMessage({ id: 'p'.repeat(192), name: 'Sky Deck' })).toBeNull()
    expect(buildPlaceActionMessage({ id: 'place-1', name: 'Sky\u0000Deck' })).toBeNull()
    expect(buildPlaceActionMessage({ id: 'place-1', name: 'n'.repeat(192) })).toBeNull()
  })

  it('posts to React Native, then WKWebView, and reports when no native channel exists', () => {
    expect(postPlaceActionToNativeHost({ id: 'place-1', name: 'Sky Deck' })).toBe(false)

    const webkitPost = vi.fn()
    vi.stubGlobal('webkit', { messageHandlers: { torchiko: { postMessage: webkitPost } } })
    expect(postPlaceActionToNativeHost({ id: 'place-1', name: 'Sky Deck' })).toBe(true)
    expect(JSON.parse(webkitPost.mock.calls[0]![0] as string)).toEqual({
      source: 'torchiko',
      v: 1,
      type: 'place-action',
      payload: { placeId: 'place-1', name: 'Sky Deck' },
    })

    const reactNativePost = vi.fn()
    vi.stubGlobal('ReactNativeWebView', { postMessage: reactNativePost })
    expect(postPlaceActionToNativeHost({ id: 'place-2', name: 'Aquarium' })).toBe(true)
    expect(reactNativePost).toHaveBeenCalledTimes(1)
    expect(webkitPost).toHaveBeenCalledTimes(1)
    expect(postPlaceActionToNativeHost({ id: '', name: 'Aquarium' })).toBe(false)
    expect(reactNativePost).toHaveBeenCalledTimes(1)
  })
})
