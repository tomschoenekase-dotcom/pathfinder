import { createHash } from 'node:crypto'
import { generateVenueQrPng } from '@pathfinder/contracts/venue-qr-print'
import {
  launchAttachmentsFromSnapshot,
  parseVenueLaunchAsset,
  parseVenueLaunchAttachments,
} from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { db } from '../client'
import { resolveVenueLaunchSource } from './venue-launch-source'

export type ProspectLaunchReadClient = Pick<
  typeof db,
  | '$queryRaw'
  | 'prospectLocationConversion'
  | 'venue'
  | 'place'
  | 'venueKnowledgeEntry'
  | 'tenantFeatureFlag'
  | 'nativeVenueDeploymentHead'
  | 'nativeVenueDeploymentEvaluationEvidence'
>

export class ProspectLaunchAttachmentError extends Error {
  readonly code = 'CONFLICT'
}

export type VerifiedCurrentProspectPrintAsset = Readonly<{
  prospectVenueId: string
  asset: VenueLaunchAsset
}>

export type ProspectLaunchAttachmentValidationOptions = Readonly<{
  client?: ProspectLaunchReadClient
  configuredOrigin?: string | null
  /** Full asset resolved by the authenticated API from an exact selection descriptor. */
  verifiedCurrentPrintAssets?: readonly VenueLaunchAsset[]
  /** Trusted outbox readback only, after the PDF was proof-validated and frozen. */
  allowFrozenVerifiedPrintAttachments?: boolean
}>

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function canonicalBytes(
  asset: VenueLaunchAsset,
  options: ProspectLaunchAttachmentValidationOptions,
): Buffer {
  if (asset.schema === 'torchiko.venue-launch-asset/1')
    return Buffer.from(renderVenueQrSvg(asset.publicUrl), 'utf8')
  if (asset.format === 'PNG' && asset.generatorVersion === 'qr-print-v1')
    return Buffer.from(generateVenueQrPng(asset.publicUrl).bytes)
  if (asset.format === 'PDF' && asset.generatorVersion === 'qr-print-v1') {
    const exactProof = options.verifiedCurrentPrintAssets?.some((proof) => {
      try {
        return hash(parseVenueLaunchAsset(proof)) === hash(asset)
      } catch {
        return false
      }
    })
    if (exactProof || options.allowFrozenVerifiedPrintAttachments)
      return Buffer.from(asset.contentBase64, 'base64')
  }
  throw new ProspectLaunchAttachmentError(
    'Canonical bytes for this QR print format are unavailable',
  )
}

/** The active conversion relation is the only prospect-location to tenant/venue authority. */
export async function readProspectLaunchLinks(
  prospectVenueId: string,
  client: ProspectLaunchReadClient = db,
) {
  return client.prospectLocationConversion.findMany({
    where: {
      prospectVenueId,
      status: 'ACTIVE',
      endedAt: null,
      relationship: { status: 'ACTIVE', endedAt: null },
    },
    select: { tenantId: true, venueId: true },
    orderBy: [{ convertedAt: 'desc' }, { id: 'desc' }],
    take: 9,
  })
}

/** Validate frozen attachments against active conversion authority and current public source. */
export async function requireCurrentProspectLaunchAttachments(
  prospectVenueId: string,
  value: unknown,
  options: ProspectLaunchAttachmentValidationOptions = {},
): Promise<VenueLaunchAsset[]> {
  const client = options.client ?? db
  const configuredOrigin = options.configuredOrigin ?? process.env.NEXT_PUBLIC_WEB_URL
  const attachments = parseVenueLaunchAttachments(value)
  if (!attachments.length) return attachments
  const links = await readProspectLaunchLinks(prospectVenueId, client)
  if (links.length > 8)
    throw new ProspectLaunchAttachmentError(
      'Launch asset scope exceeds the bounded conversion limit',
    )
  for (const asset of attachments) {
    const expectedBytes = canonicalBytes(asset, options)
    const actualBytes = Buffer.from(asset.contentBase64, 'base64')
    if (!actualBytes.equals(expectedBytes))
      throw new ProspectLaunchAttachmentError(
        'Launch asset bytes do not match the canonical QR renderer',
      )
    if (!links.some((link) => link.tenantId === asset.tenantId && link.venueId === asset.venueId))
      throw new ProspectLaunchAttachmentError(
        'Launch asset does not belong to an active converted venue',
      )
    const source = await resolveVenueLaunchSource({
      client,
      tenantId: asset.tenantId,
      venueId: asset.venueId,
      configuredOrigin,
    })
    if (
      !source ||
      source.publicUrl !== asset.publicUrl ||
      hash(source.release) !== hash(asset.release)
    )
      throw new ProspectLaunchAttachmentError('Launch asset is stale; reload the current venue QR')
  }
  return attachments
}

export function requireSameLaunchAttachments(left: unknown, right: unknown) {
  if (hash(launchAttachmentsFromSnapshot(left)) !== hash(launchAttachmentsFromSnapshot(right)))
    throw new ProspectLaunchAttachmentError('Launch attachment selection changed after review')
}

/** Preserve historical text-only hashes exactly. */
export function prospectOperationalContentHash(
  recipient: string,
  subject: string,
  body: string,
  html: string,
  snapshot: unknown,
) {
  const attachments = launchAttachmentsFromSnapshot(snapshot)
  return createHash('sha256')
    .update(
      `${recipient}\n${subject}\n${body}\n${html}` +
        (attachments.length ? `\nlaunchAttachments:${hash(attachments)}` : ''),
    )
    .digest('hex')
}
