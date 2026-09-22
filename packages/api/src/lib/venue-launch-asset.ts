import { createHash } from 'node:crypto'
import { parseVenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { db, resolveVenueLaunchSource } from '@pathfinder/db'

function asciiFilename(name: string, venueId: string): string {
  const safe = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
  const suffix = createHash('sha256').update(venueId).digest('hex').slice(0, 12)
  return `torchiko-${safe || 'venue'}-${suffix}-qr.svg`
}

/** Generate canonical QR bytes without a React server renderer dependency. */
export function renderVenueLaunchQrSvg(publicUrl: string): Buffer {
  const markup = renderVenueQrSvg(publicUrl)
  if (!markup.startsWith('<svg') || !markup.includes('<path'))
    throw new Error('Venue QR SVG generation failed')
  return Buffer.from(markup, 'utf8')
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
}): Promise<VenueLaunchAsset | null> {
  const source = await resolveVenueLaunchSource(input)
  if (!source) return null
  const bytes = renderVenueLaunchQrSvg(source.publicUrl)
  return parseVenueLaunchAsset({
    schema: 'torchiko.venue-launch-asset/1',
    tenantId: source.tenantId,
    venueId: source.venueId,
    release: source.release,
    publicUrl: source.publicUrl,
    filename: asciiFilename(source.venueName, source.venueId),
    mimeType: 'image/svg+xml',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  })
}
