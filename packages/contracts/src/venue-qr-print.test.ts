import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { generateVenueQrPng } from './venue-qr-print'
import { renderVenueQrSvg } from './venue-qr-svg'

const GUIDE_URL = 'https://guide.example.com/museum/chat?source=qr'
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function readPng(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Array<{ type: string; data: Uint8Array }> = []
  let offset = 8
  while (offset < bytes.length) {
    const length = view.getUint32(offset)
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8))
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += length + 12
    if (type === 'IEND') break
  }
  const header = chunks.find((chunk) => chunk.type === 'IHDR')?.data
  const image = chunks.find((chunk) => chunk.type === 'IDAT')?.data
  expect(header).toBeDefined()
  expect(image).toBeDefined()
  return {
    width: new DataView(header!.buffer, header!.byteOffset, header!.byteLength).getUint32(0),
    height: new DataView(header!.buffer, header!.byteOffset, header!.byteLength).getUint32(4),
    bitDepth: header![8],
    colorType: header![9],
    raw: inflateSync(image!),
  }
}

function isBlack(bitmap: ReturnType<typeof readPng>, x: number, y: number): boolean {
  const rowBytes = Math.ceil(bitmap.width / 8)
  const offset = y * (rowBytes + 1) + 1 + (x >>> 3)
  const mask = 1 << (7 - (x & 7))
  return (bitmap.raw[offset]! & mask) === 0
}

describe('deterministic venue QR PNG', () => {
  it('generates a stable 1-bit PNG at whole-module resolution below the asset ceiling', () => {
    const first = generateVenueQrPng(GUIDE_URL)
    const second = generateVenueQrPng(GUIDE_URL)

    expect(first.mimeType).toBe('image/png')
    expect(first.width).toBe(first.height)
    expect(first.width).toBeLessThanOrEqual(1_024)
    expect(first.width % 41).toBe(0)
    expect(first.bytes.byteLength).toBeLessThan(128 * 1024)
    expect(first.bytes).toEqual(second.bytes)
  })

  it('preserves the canonical matrix and four-module quiet zone', () => {
    const png = readPng(generateVenueQrPng(GUIDE_URL).bytes)
    const svg = renderVenueQrSvg(GUIDE_URL)
    const dimension = Number(svg.match(/viewBox="0 0 (\d+) /)?.[1])
    const scale = png.width / dimension
    expect(Number.isInteger(scale)).toBe(true)
    expect(png.bitDepth).toBe(1)
    expect(png.colorType).toBe(0)

    for (let edge = 0; edge < scale * 4; edge++) {
      for (let pixel = 0; pixel < png.width; pixel += Math.max(1, scale)) {
        expect(isBlack(png, pixel, edge)).toBe(false)
        expect(isBlack(png, pixel, png.height - edge - 1)).toBe(false)
        expect(isBlack(png, edge, pixel)).toBe(false)
        expect(isBlack(png, png.width - edge - 1, pixel)).toBe(false)
      }
    }

    const runs = [...svg.matchAll(/M(\d+)[, ](\d+)\s*h(\d+)v1H\d+z/g)]
    expect(runs.length).toBeGreaterThan(200)
    const [x, y, width] = runs[0]!.slice(1).map(Number) as [number, number, number]
    const pixelX = (moduleX: number) => moduleX * scale + Math.floor(scale / 2)
    const pixelY = y * scale + Math.floor(scale / 2)
    expect(isBlack(png, pixelX(x), pixelY)).toBe(true)
    expect(isBlack(png, pixelX(x + width), pixelY)).toBe(false)
  })

  it('keeps long supported guide URLs within the measured PNG size bound', () => {
    const asset = generateVenueQrPng(`https://guide.example.com/${'museum-route/'.repeat(120)}`)
    expect(asset.width).toBe(asset.height)
    expect(asset.width).toBeLessThanOrEqual(1_024)
    expect(asset.bytes.byteLength).toBeLessThan(128 * 1024)
  })

  it('retains renderer validation for unavailable or oversized guide values', () => {
    expect(() => generateVenueQrPng('')).toThrow('Invalid venue QR URL')
    expect(() => generateVenueQrPng('x'.repeat(2_001))).toThrow('Invalid venue QR URL')
  })
})
