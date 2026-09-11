/** Build a portable filename for an exported QR code. */
export function buildQrSvgFilename(label: string): string {
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

  return `${safeBasename}.svg`
}

/** Download the rendered QR SVG without changing its encoded value. */
export function downloadQrSvg(svg: SVGSVGElement | null, filename: string): void {
  if (!svg) throw new Error('QR code is not available for download.')

  const serialized = new XMLSerializer().serializeToString(svg)
  if (!serialized.includes('<svg')) throw new Error('QR code could not be serialized.')

  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' })
  const objectUrl = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.click()

  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 0)
}
