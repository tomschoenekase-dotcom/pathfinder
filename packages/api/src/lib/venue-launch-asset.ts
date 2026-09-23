import { createHash } from 'node:crypto'
import { parseVenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { generateVenueQrPng } from '@pathfinder/contracts/venue-qr-print'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { db, resolveVenueLaunchSource, type VenueLaunchSource } from '@pathfinder/db'

export type VenueLaunchAssetFormat = 'SVG' | 'PNG' | 'PDF'

function asciiFilename(name: string, venueId: string, format: VenueLaunchAssetFormat): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  const suffix = createHash('sha256').update(venueId).digest('hex').slice(0, 12)
  return `torchiko-${safe || 'venue'}-${suffix}-qr.${format.toLowerCase()}`
}

/** Generate canonical QR bytes without a React server renderer dependency. */
export function renderVenueLaunchQrSvg(publicUrl: string): Buffer {
  const markup = renderVenueQrSvg(publicUrl)
  if (!markup.startsWith('<svg') || !markup.includes('<path'))
    throw new Error('Venue QR SVG generation failed')
  return Buffer.from(markup, 'utf8')
}

/** Render exact source-bound bytes after the publication snapshot has been read. */
export async function renderVenueLaunchAsset(
  source: VenueLaunchSource,
  format: VenueLaunchAssetFormat = 'SVG',
): Promise<VenueLaunchAsset> {
  if (format === 'SVG') {
    const bytes = renderVenueLaunchQrSvg(source.publicUrl)
    return parseVenueLaunchAsset({
      schema: 'torchiko.venue-launch-asset/1',
      tenantId: source.tenantId,
      venueId: source.venueId,
      release: source.release,
      publicUrl: source.publicUrl,
      filename: asciiFilename(source.venueName, source.venueId, format),
      mimeType: 'image/svg+xml',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    })
  }
  const bytes =
    format === 'PNG'
      ? Buffer.from(generateVenueQrPng(source.publicUrl).bytes)
      : await (
          await import('./venue-qr-pdf')
        ).renderVenueQrPdf({
          venueName: source.venueName,
          publicUrl: source.publicUrl,
          qrPngBytes: Buffer.from(generateVenueQrPng(source.publicUrl).bytes),
        })
  return parseVenueLaunchAsset({
    schema: 'torchiko.venue-launch-asset/2',
    tenantId: source.tenantId,
    venueId: source.venueId,
    release: source.release,
    publicUrl: source.publicUrl,
    format,
    generatorVersion: 'qr-print-v1',
    filename: asciiFilename(source.venueName, source.venueId, format),
    mimeType: format === 'PNG' ? 'image/png' : 'application/pdf',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  })
}

/** One inert, source-bound, exact-byte venue attachment for review selection. */
export async function resolveVenueLaunchAsset(input: {
  client: Pick<
    typeof db,
    | '$queryRaw'
    | 'venue'
    | 'place'
    | 'venueKnowledgeEntry'
    | 'tenantFeatureFlag'
    | 'nativeVenueDeploymentHead'
    | 'nativeVenueDeploymentEvaluationEvidence'
  >
  tenantId: string
  venueId: string
  configuredOrigin: string | null | undefined
  environment?: Readonly<Record<string, string | undefined>>
  format?: VenueLaunchAssetFormat
}): Promise<VenueLaunchAsset | null> {
  const source = await resolveVenueLaunchSource(input)
  if (!source) return null
  return renderVenueLaunchAsset(source, input.format)
}
