/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'

import {
  buildQrFilename,
  buildQrSvgFilename,
  createQrPdfBlob,
  createQrPngBlob,
  downloadQrSvg,
  downloadQrSvgBytes,
} from './qr-export'

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

  it.each([
    ['Café / North: Tide Clock?', 'cafe-north-tide-clock.png'],
    ['CON', 'qr-con.pdf'],
    ['北側の博物館', 'qr-code.png'],
  ])('builds a portable %s export filename', (label, expected) => {
    const extension = expected.endsWith('.pdf') ? 'pdf' : 'png'
    expect(buildQrFilename(label, extension)).toBe(expected)
  })

  it('caps long export filenames at a portable basename length', () => {
    const filename = buildQrFilename('Museum and a very long venue name '.repeat(5), 'pdf')
    expect(filename).toMatch(/^[a-z0-9-]{1,80}\.pdf$/)
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

  it('creates one printable letter PDF with a vector QR and public address', async () => {
    const url = 'https://guide.example.com/museum/chat?source=qr'
    const blob = createQrPdfBlob('Café 北 Museum', url)

    expect(blob.type).toBe('application/pdf')
    const reader = new FileReader()
    const pdf = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(pdf.startsWith('%PDF-1.4')).toBe(true)
    expect(pdf).toContain('/MediaBox [0 0 612 792]')
    expect(pdf).toContain('/Count 1')
    expect(pdf).toContain('Scan to open the visitor guide.')
    expect(pdf).toContain(url)
    expect(pdf).toContain('Cafe ? Museum')
    expect(pdf).toContain('re f')
    expect((pdf.match(/ re f\n/g) ?? []).length).toBeGreaterThan(200)
    expect(pdf).toContain('startxref')
  })

  it('renders a lossless PNG at whole-module boundaries with a white quiet zone', async () => {
    const originalImage = globalThis.Image
    const originalCreateElement = document.createElement.bind(document)
    const drawImage = vi.fn()
    let requestedType = ''
    let canvasWidth = 0
    let canvasHeight = 0
    const fillRect = vi.fn()
    const canvas = {
      set width(value: number) {
        canvasWidth = value
      },
      get width() {
        return canvasWidth
      },
      set height(value: number) {
        canvasHeight = value
      },
      get height() {
        return canvasHeight
      },
      getContext: vi.fn(() => ({
        fillStyle: '',
        imageSmoothingEnabled: true,
        fillRect,
        drawImage,
      })),
      toBlob: (callback: BlobCallback, type: string) => {
        requestedType = type
        callback(new Blob(['png-fixture'], { type }))
      },
    }
    class LoadedImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        this.onload?.()
      }
    }
    vi.stubGlobal('Image', LoadedImage)
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') return canvas as unknown as HTMLCanvasElement
      return originalCreateElement(tagName)
    }) as typeof document.createElement)

    try {
      const blob = await createQrPngBlob('https://guide.example.com/museum/chat?source=qr')
      const svg = renderVenueQrSvg('https://guide.example.com/museum/chat?source=qr')
      const dimension = Number(svg.match(/viewBox="0 0 (\d+) /)?.[1])
      expect(blob.type).toBe('image/png')
      expect(requestedType).toBe('image/png')
      expect(canvasWidth).toBe(canvasHeight)
      expect(canvasWidth).toBeLessThanOrEqual(1_024)
      expect(dimension).toBeGreaterThan(0)
      expect(canvasWidth % dimension).toBe(0)
      expect(drawImage).toHaveBeenCalledOnce()
      expect(fillRect).toHaveBeenCalledWith(0, 0, canvasWidth, canvasHeight)
    } finally {
      vi.stubGlobal('Image', originalImage)
    }
  })
})
