import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import sharp from 'sharp'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const PAGE_MARGIN = 42
const QR_PRINT_SIZE = 432
const TEXT_RASTER_WIDTH = 1_440
const FONT_BASE = '/usr/share/fonts/torchiko'
const FONT_ASSETS = [
  ['noto-sans-latin', 'NotoSans-Regular.otf'],
  ['noto-sans-arabic', 'NotoSansArabic-Regular.ttf'],
  ['noto-sans-cjk-sc', 'NotoSansCJKsc-Regular.otf'],
] as const

type FontFiles = { latin: string }
type RasterImage = { width: number; height: number; rgb: Uint8Array }
type PdfObject = Uint8Array

function resolveFonts(): FontFiles {
  const roots = [
    process.env.VENUE_QR_FONT_DIR,
    FONT_BASE,
    resolve(process.cwd(), 'packages/api/assets/fonts'),
    resolve(process.cwd(), '../../packages/api/assets/fonts'),
  ].filter((path): path is string => Boolean(path))
  for (const root of roots) {
    const paths = FONT_ASSETS.map(([folder, file]) => resolve(root, folder, file))
    if (paths.every(existsSync)) return { latin: paths[0]! }
  }
  throw new Error(
    'Venue QR PDF fonts are missing; install the bundled Noto fonts and refresh Fontconfig.',
  )
}

function escapePango(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function renderText(text: string, height: number, fontSize: number): Promise<RasterImage> {
  const { latin } = resolveFonts()
  const png = await sharp({
    text: {
      text: escapePango(text),
      font: `Noto Sans ${fontSize}`,
      fontfile: latin,
      width: TEXT_RASTER_WIDTH,
      height,
      align: 'center',
      wrap: 'word-char',
      rgba: false,
    },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer()
  const { data, info } = await sharp(png)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 3 || info.width > TEXT_RASTER_WIDTH || info.height > height) {
    throw new Error(
      `Venue QR PDF text did not fit its printable area (${info.width}×${info.height}, ${info.channels} channels).`,
    )
  }
  // libvips' text input defaults to light ink on a black canvas. Invert the
  // raster for conventional black text on a white print sheet.
  for (let index = 0; index < data.length; index++) data[index] = 255 - data[index]!
  return { width: info.width, height: info.height, rgb: data }
}

function placeImage(
  name: string,
  image: { width: number; height: number },
  x: number,
  y: number,
  scale: number,
): string {
  const width = image.width * scale
  const height = image.height * scale
  return `q\n${width.toFixed(4)} 0 0 ${height.toFixed(4)} ${x.toFixed(4)} ${y.toFixed(4)} cm /${name} Do\nQ`
}

function parseQrPng(bytes: Uint8Array): { width: number; height: number; idat: Uint8Array } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('The venue QR asset is not a valid canonical PNG.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (
    !width ||
    !height ||
    width !== height ||
    bytes[24] !== 1 ||
    bytes[25] !== 0 ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  ) {
    throw new Error('The venue QR asset must use the canonical 1-bit grayscale PNG format.')
  }
  let offset = 8
  const idat: Uint8Array[] = []
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (offset + length + 12 > bytes.length)
      throw new Error('The venue QR PNG has a truncated chunk.')
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += length + 12
    if (type === 'IEND') break
  }
  if (!idat.length) throw new Error('The venue QR PNG is missing its image data.')
  const size = idat.reduce((total, chunk) => total + chunk.length, 0)
  const joined = new Uint8Array(size)
  let cursor = 0
  for (const chunk of idat) {
    joined.set(chunk, cursor)
    cursor += chunk.length
  }
  return { width, height, idat: joined }
}

function ascii(value: string): Uint8Array {
  return Buffer.from(value, 'ascii')
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function pdfStream(dictionary: string, data: Uint8Array): PdfObject {
  return concat([
    ascii(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    ascii('\nendstream'),
  ])
}

function makePdf(objects: readonly PdfObject[], trailerEntries = '/Root 1 0 R'): Uint8Array {
  const parts: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')]
  const offsets = [0]
  let length = parts[0]!.length
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length)
    const object = concat([ascii(`${index + 1} 0 obj\n`), objects[index]!, ascii('\nendobj\n')])
    parts.push(object)
    length += object.length
  }
  const xrefOffset = length
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n']
  for (const offset of offsets.slice(1)) xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`)
  parts.push(ascii(xref.join('')))
  parts.push(
    ascii(
      `trailer\n<< /Size ${objects.length + 1} ${trailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  )
  return concat(parts)
}

function imageObject(image: RasterImage): PdfObject {
  const compressed = deflateSync(image.rgb, { level: 9 })
  return pdfStream(
    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    compressed,
  )
}

function qrImageObject(image: { width: number; height: number; idat: Uint8Array }): PdfObject {
  return pdfStream(
    `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [0 1] /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 1 /Columns ${image.width} >>`,
    image.idat,
  )
}

/**
 * Create a deterministic, single-page Letter print sheet using the canonical QR PNG.
 * Text is rasterized server-side with bundled Noto fonts so Arabic and CJK glyphs
 * remain visually legible in PDF viewers without embedding complex OpenType fonts.
 */
export async function renderVenueQrPdf(input: {
  venueName: string
  publicUrl: string
  qrPngBytes: Uint8Array
}): Promise<Buffer> {
  const venueName = input.venueName.trim().replace(/\s+/gu, ' ')
  const publicUrl = input.publicUrl.trim()
  if (!venueName || [...venueName].length > 180)
    throw new Error('Venue name must contain 1 to 180 characters.')
  if (!/^https:\/\//u.test(publicUrl) || [...publicUrl].length > 300) {
    throw new Error(
      'Public URL must be HTTPS and no longer than 300 characters for print readability.',
    )
  }

  const [title, instruction, url, brand, qr] = await Promise.all([
    renderText(venueName, 270, 60),
    renderText('Scan to open the visitor guide', 74, 34),
    renderText(publicUrl, 130, 32),
    renderText('Torchiko', 48, 24),
    Promise.resolve(parseQrPng(input.qrPngBytes)),
  ])
  const printableWidth = PAGE_WIDTH - PAGE_MARGIN * 2
  const titleScale = Math.min(0.36, printableWidth / title.width)
  const titleWidth = title.width * titleScale
  const titleHeight = title.height * titleScale
  const titleX = (PAGE_WIDTH - titleWidth) / 2
  const instructionScale = Math.min(0.36, printableWidth / instruction.width)
  const instructionWidth = instruction.width * instructionScale
  const instructionHeight = instruction.height * instructionScale
  const instructionX = (PAGE_WIDTH - instructionWidth) / 2
  const urlScale = Math.min(0.36, printableWidth / url.width)
  const urlWidth = url.width * urlScale
  const urlHeight = url.height * urlScale
  const urlX = (PAGE_WIDTH - urlWidth) / 2
  const brandScale = Math.min(0.36, printableWidth / brand.width)
  const brandWidth = brand.width * brandScale
  const brandHeight = brand.height * brandScale
  const brandX = (PAGE_WIDTH - brandWidth) / 2
  const qrX = (PAGE_WIDTH - QR_PRINT_SIZE) / 2
  const titleBottom = PAGE_HEIGHT - PAGE_MARGIN - titleHeight
  const instructionBottom = titleBottom - 8 - instructionHeight
  const qrTop = instructionBottom - 14
  const qrBottom = qrTop - QR_PRINT_SIZE
  const urlBottom = qrBottom - 14 - urlHeight
  const brandBottom = urlBottom - 9 - brandHeight
  if (brandBottom < PAGE_MARGIN)
    throw new Error('Venue QR name and URL do not fit on one printable page.')

  const content = ascii(
    [
      placeImage('Title', title, titleX, PAGE_HEIGHT - PAGE_MARGIN - titleHeight, titleScale),
      placeImage('Instruction', instruction, instructionX, instructionBottom, instructionScale),
      placeImage('QR', qr, qrX, qrBottom, QR_PRINT_SIZE / qr.width),
      placeImage('URL', url, urlX, urlBottom, urlScale),
      placeImage('Brand', brand, brandX, brandBottom, brandScale),
    ].join('\n') + '\n',
  )

  const pdf = makePdf(
    [
      ascii('<< /Type /Catalog /Pages 2 0 R >>'),
      ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /XObject << /QR 4 0 R /Title 5 0 R /Instruction 6 0 R /URL 7 0 R /Brand 8 0 R >> >> /Contents 9 0 R >>`,
      ),
      qrImageObject(qr),
      imageObject(title),
      imageObject(instruction),
      imageObject(url),
      imageObject(brand),
      pdfStream('', content),
      ascii('<< /Title (Torchiko QR visitor guide) /Subject (Scan to open the visitor guide) >>'),
    ],
    '/Root 1 0 R /Info 10 0 R',
  )
  return Buffer.from(pdf)
}
