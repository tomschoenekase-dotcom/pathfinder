import { createHash } from 'node:crypto'
import { db, readProspectLaunchLinks, type VerifiedCurrentProspectPrintAsset } from '@pathfinder/db'
import {
  AnyVenueLaunchAssetSelectionSchema,
  venueLaunchAssetDescriptor,
  type VenueLaunchAsset,
  type VenueLaunchAssetSelection,
} from '@pathfinder/contracts/venue-launch-asset'
import { launchAttachmentsFromSnapshot } from '@pathfinder/contracts/venue-launch-asset-node'
import { resolveVenueLaunchAsset } from './lib/venue-launch-asset'

const MAX_PROSPECT_LAUNCH_ASSET_LINKS = 8

function selectionHash(selection: VenueLaunchAssetSelection) {
  return createHash('sha256')
    .update(JSON.stringify(AnyVenueLaunchAssetSelectionSchema.parse(selection)))
    .digest('hex')
}

function assetSelection(asset: VenueLaunchAsset): VenueLaunchAssetSelection {
  return AnyVenueLaunchAssetSelectionSchema.parse({
    tenantId: asset.tenantId,
    venueId: asset.venueId,
    release: asset.release,
    publicUrl: asset.publicUrl,
    sha256: asset.sha256,
    ...(asset.schema === 'torchiko.venue-launch-asset/2'
      ? { format: asset.format, generatorVersion: asset.generatorVersion }
      : {}),
  })
}

/** Resolve server-generated current assets only for active conversion links. */
export async function readProspectLaunchAssets(
  prospectVenueId: string,
): Promise<VenueLaunchAsset[]> {
  const links = await readProspectLaunchLinks(prospectVenueId)
  if (links.length > MAX_PROSPECT_LAUNCH_ASSET_LINKS)
    throw new Error('LAUNCH_ASSET_SCOPE_EXCEEDS_BOUND')
  const assets: VenueLaunchAsset[] = []
  for (const link of links) {
    const asset = await db.$transaction(
      (client) =>
        resolveVenueLaunchAsset({
          client,
          ...link,
          configuredOrigin: process.env.NEXT_PUBLIC_WEB_URL,
        }),
      { isolationLevel: 'RepeatableRead' },
    )
    if (asset) assets.push(asset)
  }
  return assets
}

export async function selectProspectLaunchAsset(
  prospectVenueId: string,
  selection: VenueLaunchAssetSelection,
): Promise<VenueLaunchAsset> {
  const expected = AnyVenueLaunchAssetSelectionSchema.parse(selection)
  const assets = await readProspectLaunchAssets(prospectVenueId)
  const asset = assets.find(
    (candidate) => selectionHash(assetSelection(candidate)) === selectionHash(expected),
  )
  if (!asset) throw new Error('LAUNCH_ASSET_STALE: select the exact current converted venue QR')
  return asset
}

/** Resolve PDF proof from frozen selection identities; never accept caller-supplied bytes. */
export async function resolveVerifiedCurrentPrintAssets(
  prospectVenueId: string,
  snapshot: unknown,
): Promise<VerifiedCurrentProspectPrintAsset[]> {
  const frozen = launchAttachmentsFromSnapshot(snapshot)
  const printPdfs = frozen.filter(
    (asset) => asset.schema === 'torchiko.venue-launch-asset/2' && asset.format === 'PDF',
  )
  const verified: VerifiedCurrentProspectPrintAsset[] = []
  for (const asset of printPdfs) {
    const current = await selectProspectLaunchAsset(prospectVenueId, assetSelection(asset))
    if (
      selectionHash(assetSelection(current)) !== selectionHash(assetSelection(asset)) ||
      current.contentBase64 !== asset.contentBase64
    )
      throw new Error(
        'LAUNCH_ASSET_STALE: frozen PDF is not the exact current server-rendered asset',
      )
    verified.push({ prospectVenueId, asset: current })
  }
  return verified
}

export async function prospectLaunchAssetView(prospectVenueId: string) {
  try {
    const assets = await readProspectLaunchAssets(prospectVenueId)
    return {
      available: assets.map(venueLaunchAssetDescriptor),
      hold: assets.length
        ? null
        : 'No current QR is available for an active converted venue. Open the venue QR kit after its visitor guide is ready.',
    }
  } catch {
    return {
      available: [],
      hold: 'Current venue QR could not be verified. Reload before selecting an attachment.',
    }
  }
}
