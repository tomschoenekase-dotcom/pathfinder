import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'

const QR_MARGIN_MODULES = 4
const PNG_TARGET_PIXELS = 1_024

/** Build a portable filename for an exported QR code. */
export function buildQrFilename(label: string, extension: 'svg' | 'png' | 'pdf'): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/g, '')

  const basename = slug || 'qr-code'
  const safeBasename = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)
    ? `qr-${basename}`
    : basename

  return `${safeBasename}.${extension}`
}

/** Kept for callers that still explicitly name the SVG-specific helper. */
export function buildQrSvgFilename(label: string): string {
  return buildQrFilename(label, 'svg')
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()

  // Safari may not consume a programmatic download before the current task ends.
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 60_000)
}

/** Download the rendered QR SVG without changing its encoded value. */
export function downloadQrSvg(svg: SVGSVGElement | null, filename: string): void {
  if (!svg) throw new Error('QR code is not available for download.')

  const serialized = new XMLSerializer().serializeToString(svg)
  if (!serialized.includes('<svg')) throw new Error('QR code could not be serialized.')

  saveBlob(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }), filename)
}

/** Download the exact server-reviewed venue QR bytes. */
export function downloadQrSvgBytes(contentBase64: string, filename: string): void {
  downloadQrAssetBytes(contentBase64, 'image/svg+xml', filename)
}

/** Download the exact server-generated asset bytes with their declared MIME. */
export function downloadQrAssetBytes(
  contentBase64: string,
  mimeType: string,
  filename: string,
): void {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(contentBase64)) {
    throw new Error('The QR asset bytes are invalid.')
  }
  const binary = window.atob(contentBase64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  saveBlob(new Blob([bytes], { type: mimeType }), filename)
}

function svgDataUrl(publicUrl: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderVenueQrSvg(publicUrl))}`
}

function loadQrImage(publicUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The QR image could not be prepared.'))
    image.src = svgDataUrl(publicUrl)
  })
}

/** Rasterize the canonical four-module SVG on whole-module pixel boundaries. */
export async function createQrPngBlob(publicUrl: string): Promise<Blob> {
  const svg = renderVenueQrSvg(publicUrl)
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  if (!viewBox) throw new Error('The QR image has invalid dimensions.')
  const modulesWide = Number(viewBox[1])
  const modulesHigh = Number(viewBox[2])
  if (modulesWide !== modulesHigh || modulesWide < QR_MARGIN_MODULES * 2 + 21) {
    throw new Error('The QR image has invalid dimensions.')
  }

  const pixelsPerModule = Math.max(5, Math.floor(PNG_TARGET_PIXELS / modulesWide))
  const canvas = document.createElement('canvas')
  canvas.width = modulesWide * pixelsPerModule
  canvas.height = modulesHigh * pixelsPerModule
  const context = canvas.getContext('2d')
  if (!context) throw new Error('PNG export is unavailable in this browser. Try again.')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = false
  const image = await loadQrImage(publicUrl)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== 'image/png') {
        reject(new Error('PNG export could not be completed. Try again.'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

export async function downloadQrPng(publicUrl: string, filename: string): Promise<void> {
  saveBlob(await createQrPngBlob(publicUrl), filename)
}

function escapePdfText(value: string): string {
  // PDF's built-in Helvetica uses WinAnsi. Keep accented Latin characters and
  // replace characters that the built-in font cannot represent.
  const transliterated = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '?')
  return transliterated.replace(/[\\()]/g, '\\$&')
}

function wrapPdfText(value: string, maxChars: number): string[] {
  const words = escapePdfText(value).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (let word of words) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line)
      line = ''
    }
    while (word.length > maxChars) {
      if (line) lines.push(line)
      lines.push(word.slice(0, maxChars))
      word = word.slice(maxChars)
      line = ''
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : [' ']
}

function pdfLiteral(value: string): string {
  // Encode WinAnsi bytes as octal escapes so the generated PDF remains ASCII.
  return `(${Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code > 0x7e ? `\\${code.toString(8).padStart(3, '0')}` : character
  }).join('')})`
}

function extractQrRects(svg: string): {
  dimension: number
  rects: Array<[number, number, number]>
} {
  const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  const paths = [...svg.matchAll(/<path\b(?=[^>]*\bfill="#000000")[^>]*\bd="([^"]+)"[^>]*>/g)]
  if (!viewBox || viewBox[1] !== viewBox[2] || paths.length !== 1) {
    throw new Error('The QR image could not be prepared for PDF.')
  }

  const rects: Array<[number, number, number]> = []
  const run = /M(\d+)[, ](\d+)\s*h(\d+)v1H\d+z/g
  for (const match of paths[0]![1]!.matchAll(run)) {
    rects.push([Number(match[1]), Number(match[2]), Number(match[3])])
  }
  if (!rects.length) throw new Error('The QR image could not be prepared for PDF.')
  return { dimension: Number(viewBox[1]), rects }
}

function buildPdf(svg: string, venueName: string, publicUrl: string): Uint8Array {
  const { dimension, rects } = extractQrRects(svg)
  const pageWidth = 612
  const pageHeight = 792
  const margin = 54
  const qrSize = 470
  const qrScale = qrSize / dimension
  const qrX = (pageWidth - qrSize) / 2
  const qrY = 100
  const titleLines = wrapPdfText(venueName, 48).slice(0, 3)
  const urlLines = wrapPdfText(publicUrl, 76).slice(0, 2)
  const commands = ['q', '1 1 1 rg', `0 0 ${pageWidth} ${pageHeight} re f`, '0 0 0 rg']
  let textY = pageHeight - margin - 22
  commands.push('BT', '/F1 22 Tf')
  for (const line of titleLines) {
    commands.push(`1 0 0 1 ${margin} ${textY} Tm ${pdfLiteral(line)} Tj`)
    textY -= 28
  }
  commands.push(
    '/F1 12 Tf',
    `1 0 0 1 ${margin} ${textY - 4} Tm ${pdfLiteral('Scan to open the visitor guide.')} Tj`,
  )
  textY -= 28
  commands.push('/F1 9 Tf')
  for (const line of urlLines) {
    commands.push(`1 0 0 1 ${margin} ${textY} Tm ${pdfLiteral(line)} Tj`)
    textY -= 13
  }
  commands.push('ET')
  // Draw each dark run as a vector rectangle. The light page provides the
  // quiet zone already present in the canonical SVG's four-module border.
  for (const [x, y, width] of rects) {
    const left = qrX + x * qrScale
    const bottom = qrY + (dimension - y - 1) * qrScale
    commands.push(
      `${left.toFixed(3)} ${bottom.toFixed(3)} ${(width * qrScale).toFixed(3)} ${qrScale.toFixed(3)} re f`,
    )
  }
  commands.push(
    '0 0 0 rg',
    'BT',
    '/F1 10 Tf',
    `1 0 0 1 ${margin} 52 Tm (Torchiko visitor guide) Tj`,
    'ET',
    'Q',
  )

  const stream = `${commands.join('\n')}\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ]
  let documentText = '%PDF-1.4\n%QR1\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(new TextEncoder().encode(documentText).length)
    documentText += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = new TextEncoder().encode(documentText).length
  documentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    documentText += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  documentText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return new TextEncoder().encode(documentText)
}

/** Create a one-page US Letter sign with a vector QR and four-module quiet zone. */
export function createQrPdfBlob(venueName: string, publicUrl: string): Blob {
  const svg = renderVenueQrSvg(publicUrl)
  const bytes = buildPdf(svg, venueName, publicUrl)
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Blob([buffer], { type: 'application/pdf' })
}

export function downloadQrPdf(venueName: string, publicUrl: string, filename: string): void {
  saveBlob(createQrPdfBlob(venueName, publicUrl), filename)
}
