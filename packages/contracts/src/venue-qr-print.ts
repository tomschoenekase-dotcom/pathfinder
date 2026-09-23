import { renderVenueQrSvg } from './venue-qr-svg'

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_TARGET_PIXELS = 1_024
const MIN_PIXELS_PER_MODULE = 5

export type VenueQrPng = {
  bytes: Uint8Array
  width: number
  height: number
  mimeType: 'image/png'
}

type DarkRun = { x: number; y: number; width: number }

function parseCanonicalSvg(publicUrl: string): { dimension: number; runs: DarkRun[] } {
  const svg = renderVenueQrSvg(publicUrl)
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  const paths = [...svg.matchAll(/<path\b(?=[^>]*\bfill="#000000")[^>]*\bd="([^"]+)"[^>]*>/g)]
  if (!viewBox || viewBox[1] !== viewBox[2] || paths.length !== 1) {
    throw new Error('The canonical venue QR could not be read.')
  }

  const dimension = Number(viewBox[1])
  const runs: DarkRun[] = []
  // `renderVenueQrSvg` emits one horizontal run per SVG path segment. Accept
  // both its usual `M4 4h...` and end-of-row `M30,4 h...` forms.
  for (const match of paths[0]![1]!.matchAll(/M(\d+)[, ](\d+)\s*h(\d+)v1H\d+z/g)) {
    const x = Number(match[1])
    const y = Number(match[2])
    const width = Number(match[3])
    if (x < 0 || y < 0 || width <= 0 || x + width > dimension || y >= dimension) {
      throw new Error('The canonical venue QR contains an invalid module path.')
    }
    runs.push({ x, y, width })
  }
  if (!runs.length) throw new Error('The canonical venue QR has no dark modules.')
  return { dimension, runs }
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function uint32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let value = i
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** Deterministic zlib stream using stored DEFLATE blocks. */
function deflateStored(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
  for (let offset = 0; offset < bytes.length; offset += 65_535) {
    const length = Math.min(65_535, bytes.length - offset)
    const final = offset + length === bytes.length
    const header = new Uint8Array([
      final ? 1 : 0,
      length & 0xff,
      (length >>> 8) & 0xff,
      ~length & 0xff,
      (~length >>> 8) & 0xff,
    ])
    parts.push(header, bytes.subarray(offset, offset + length))
  }
  parts.push(uint32be(adler32(bytes)))
  return concatenate(parts)
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const crc = crc32(concatenate([typeBytes, data]))
  return concatenate([uint32be(data.length), typeBytes, data, uint32be(crc)])
}

function makeBitmap(dimension: number, runs: readonly DarkRun[], scale: number): Uint8Array {
  const width = dimension * scale
  const rowBytes = Math.ceil(width / 8)
  const bitmap = new Uint8Array(width * (rowBytes + 1))
  for (let y = 0; y < width; y++) {
    const rowStart = y * (rowBytes + 1)
    bitmap[rowStart] = 0 // PNG filter type: None.
    bitmap.fill(0xff, rowStart + 1, rowStart + 1 + rowBytes) // Indexed grayscale white.
  }

  for (const run of runs) {
    const left = run.x * scale
    const right = (run.x + run.width) * scale
    const top = run.y * scale
    const bottom = top + scale
    for (let y = top; y < bottom; y++) {
      const rowStart = y * (rowBytes + 1) + 1
      for (let x = left; x < right; x++) {
        const byteOffset = rowStart + (x >>> 3)
        const bitMask = 1 << (7 - (x & 7))
        bitmap[byteOffset] = bitmap[byteOffset]! & ~bitMask
      }
    }
  }
  return bitmap
}

/**
 * Render a lossless, deterministic 1-bit PNG from the canonical venue QR SVG.
 * Every module remains an integer number of pixels and the source keeps its
 * four-module light quiet zone. The output is dependency-free and safe to call
 * from server routes without importing browser or image-processing code.
 */
export function generateVenueQrPng(publicUrl: string): VenueQrPng {
  const { dimension, runs } = parseCanonicalSvg(publicUrl)
  const scale = Math.max(MIN_PIXELS_PER_MODULE, Math.floor(PNG_TARGET_PIXELS / dimension))
  const width = dimension * scale
  const height = width
  const bitmap = makeBitmap(dimension, runs, scale)
  const header = concatenate([
    uint32be(width),
    uint32be(height),
    new Uint8Array([1, 0, 0, 0, 0]), // 1-bit grayscale, deflate, adaptive filter, no interlace.
  ])
  const png = concatenate([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateStored(bitmap)),
    pngChunk('IEND', new Uint8Array()),
  ])

  return { bytes: png, width, height, mimeType: 'image/png' }
}
