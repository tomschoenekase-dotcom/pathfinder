import { NayukiQrCode, NayukiQrSegment } from './venue-qr-nayuki'

type QrMatrix = boolean[][]
type QrCode = { getModules(): QrMatrix }
type QrEncoder = {
  Ecc: { MEDIUM: unknown }
  encodeSegments(
    segments: unknown[],
    errorCorrection: unknown,
    minVersion: number,
    maxVersion: number,
    mask: number,
    boostLevel: boolean,
  ): QrCode
}
type QrSegments = { makeSegments(value: string): unknown[] }

const encoder = NayukiQrCode as QrEncoder
const segments = NayukiQrSegment as QrSegments

/** Path grouping matches qrcode.react 4.2.0's SVG renderer. */
function darkModulePath(modules: QrMatrix, margin: number): string {
  const operations: string[] = []
  modules.forEach((row, y) => {
    let start: number | null = null
    row.forEach((dark, x) => {
      if (!dark && start !== null) {
        operations.push(`M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`)
        start = null
        return
      }
      if (x === row.length - 1) {
        if (!dark) return
        if (start === null) operations.push(`M${x + margin},${y + margin} h1v1H${x + margin}z`)
        else
          operations.push(`M${start + margin},${y + margin} h${x + 1 - start}v1H${start + margin}z`)
        return
      }
      if (dark && start === null) start = x
    })
  })
  return operations.join('')
}

/** Pure, deterministic SVG QR: 208 px, medium ECC, four-module quiet zone. */
export function renderVenueQrSvg(publicUrl: string): string {
  if (!publicUrl || publicUrl.length > 2_000) throw new Error('Invalid venue QR URL')
  const code = encoder.encodeSegments(
    segments.makeSegments(publicUrl),
    encoder.Ecc.MEDIUM,
    1,
    40,
    -1,
    true,
  )
  const modules = code.getModules()
  const dimension = modules.length + 8
  const path = darkModulePath(modules, 4)
  return `<svg xmlns="http://www.w3.org/2000/svg" height="208" width="208" viewBox="0 0 ${dimension} ${dimension}" role="img"><title>Venue guest guide QR code</title><path fill="#FFFFFF" d="M0,0 h${dimension}v${dimension}H0z" shape-rendering="crispEdges"></path><path fill="#000000" d="${path}" shape-rendering="crispEdges"></path></svg>`
}
