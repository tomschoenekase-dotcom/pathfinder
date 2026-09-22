/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildQrSvgFilename, downloadQrSvg, downloadQrSvgBytes } from './qr-export'

describe('QR SVG export', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    ['Harbor House guest guide', 'harbor-house-guest-guide.svg'],
    ['Café / North: Tide Clock?', 'cafe-north-tide-clock.svg'],
    ['', 'qr-code.svg'],
    ['CON', 'qr-con.svg'],
  ])('creates a safe filename for %s', (label, expected) => {
    expect(buildQrSvgFilename(label)).toBe(expected)
  })

  it('downloads the serialized SVG with the exact requested filename', () => {
    vi.useFakeTimers()
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 21 21')
    svg.innerHTML = '<path d="M0 0h1v1H0z" />'
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:qr',
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    })
    const createObjectURL = vi.spyOn(window.URL, 'createObjectURL').mockReturnValue('blob:qr')
    const revokeObjectURL = vi
      .spyOn(window.URL, 'revokeObjectURL')
      .mockImplementation(() => undefined)
    const anchor = document.createElement('a')
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => undefined)

    downloadQrSvg(svg, 'harbor-house.svg')

    expect(createObjectURL).toHaveBeenCalledOnce()
    const blob = createObjectURL.mock.calls[0]![0]
    expect(blob).toBeInstanceOf(Blob)
    expect((blob as Blob).type).toBe('image/svg+xml;charset=utf-8')
    expect(createElement).toHaveBeenCalledWith('a')
    expect(click).toHaveBeenCalledOnce()
    expect(anchor.download).toBe('harbor-house.svg')
    expect(anchor.href).toBe('blob:qr')
    vi.runAllTimers()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:qr')
  })

  it('fails when the rendered QR element is unavailable', () => {
    expect(() => downloadQrSvg(null, 'qr.svg')).toThrow('QR code is not available')
  })

  it('downloads the server QR bytes with its source filename', () => {
    vi.useFakeTimers()
    const bytes = '<svg><path d="M0 0h1"/></svg>'
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => 'blob:venue-qr',
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => undefined,
    })
    const createObjectURL = vi.spyOn(window.URL, 'createObjectURL')
    const anchor = document.createElement('a')
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(anchor, 'click').mockImplementation(() => undefined)
    downloadQrSvgBytes(btoa(bytes), 'torchiko-museum-qr.svg')
    const blob = createObjectURL.mock.calls[0]![0] as Blob
    expect(blob.size).toBe(bytes.length)
    expect(blob.type).toBe('image/svg+xml')
    expect(anchor.download).toBe('torchiko-museum-qr.svg')
    vi.runAllTimers()
  })
})
