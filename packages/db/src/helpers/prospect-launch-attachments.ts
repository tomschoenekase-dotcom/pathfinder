import { createHash } from 'node:crypto'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { parseVenueLaunchAttachments, launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { resolveVenueLaunchSource } from './venue-launch-source'
import { db } from '../client'
import { ProspectSalesError, salesHash } from './prospect-sales-snapshot'

export type ProspectLaunchReadClient = Pick<typeof db, '$queryRaw' | 'prospectLocationConversion' | 'venue' | 'place' | 'venueKnowledgeEntry' |
  'tenantFeatureFlag' | 'nativeVenueDeploymentHead' | 'nativeVenueDeploymentEvaluationEvidence'>

/** Only the existing active conversion owns the prospect -> product venue link. */
export async function readProspectLaunchLinks(prospectVenueId: string, client: ProspectLaunchReadClient = db) {
  return client.prospectLocationConversion.findMany({
    where: { prospectVenueId, status: 'ACTIVE', endedAt: null,
      relationship: { status: 'ACTIVE', endedAt: null } },
    select: { tenantId: true, venueId: true },
    orderBy: [{ convertedAt: 'desc' }, { id: 'desc' }], take: 9,
  })
}

/** No fetch or byte replacement: reviewed bytes are immutable; source currentness
 * and active conversion authority are rechecked before each new approval/send. */
export async function requireCurrentProspectLaunchAttachments(
  prospectVenueId: string, value: unknown, client: ProspectLaunchReadClient = db,
): Promise<VenueLaunchAsset[]> {
  const attachments = parseVenueLaunchAttachments(value)
  if (!attachments.length) return attachments
  const links = await readProspectLaunchLinks(prospectVenueId, client)
  if (links.length > 8) throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_SCOPE_EXCEEDS_BOUND')
  for (const asset of attachments) {
    if (!Buffer.from(asset.contentBase64, 'base64').equals(Buffer.from(renderVenueQrSvg(asset.publicUrl), 'utf8')))
      throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_BYTES_MISMATCH: current canonical venue QR required')
    if (!links.some((link) => link.tenantId === asset.tenantId && link.venueId === asset.venueId))
      throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_VENUE_MISMATCH: current converted venue required')
    const source = await resolveVenueLaunchSource({ client, tenantId: asset.tenantId,
      venueId: asset.venueId, configuredOrigin: process.env.NEXT_PUBLIC_WEB_URL })
    if (!source || source.publicUrl !== asset.publicUrl ||
        salesHash(source.release) !== salesHash(asset.release))
      throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_STALE: reload the current venue QR and prepare a new revision')
  }
  return attachments
}

export function requireSameLaunchAttachments(left: unknown, right: unknown) {
  if (salesHash(launchAttachmentsFromSnapshot(left)) !== salesHash(launchAttachmentsFromSnapshot(right)))
    throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_SNAPSHOT_CHANGED: exact reviewed QR required')
}

/** Preserve historical text-only hashes exactly. */
export function prospectOperationalContentHash(recipient: string, subject: string, body: string,
  html: string, snapshot: unknown) {
  const attachments = launchAttachmentsFromSnapshot(snapshot)
  return createHash('sha256').update(`${recipient}\n${subject}\n${body}\n${html}` +
    (attachments.length ? `\nlaunchAttachments:${salesHash(attachments)}` : '')).digest('hex')
}
