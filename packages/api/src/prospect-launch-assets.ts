import { db } from '@pathfinder/db'
import { readProspectLaunchLinks } from '@pathfinder/db'
import { ProspectSalesError, salesHash } from '@pathfinder/db'
import { VenueLaunchAssetSelectionSchema, venueLaunchAssetDescriptor, type VenueLaunchAssetSelection } from '@pathfinder/contracts/venue-launch-asset'
import { resolveVenueLaunchAsset } from './lib/venue-launch-asset'

/** Resolve only canonical converted venues. Input is a selection identity, never bytes or a fetch URL. */
export async function readProspectLaunchAssets(prospectVenueId: string) {
  const links = await readProspectLaunchLinks(prospectVenueId)
  if (links.length > 8) throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_SCOPE_EXCEEDS_BOUND')
  const assets = []
  for (const link of links) {
    const asset = await db.$transaction((client) => resolveVenueLaunchAsset({
      client, ...link, configuredOrigin: process.env.NEXT_PUBLIC_WEB_URL,
    }), { isolationLevel: 'RepeatableRead' })
    if (asset) assets.push(asset)
  }
  return assets
}

export async function selectProspectLaunchAsset(prospectVenueId: string, selection: VenueLaunchAssetSelection) {
  const expected = VenueLaunchAssetSelectionSchema.parse(selection)
  const assets = await readProspectLaunchAssets(prospectVenueId)
  const asset = assets.find((candidate) => salesHash(VenueLaunchAssetSelectionSchema.parse({
    tenantId: candidate.tenantId, venueId: candidate.venueId, release: candidate.release,
    publicUrl: candidate.publicUrl, sha256: candidate.sha256,
  })) === salesHash(expected))
  if (!asset) throw new ProspectSalesError('CONFLICT', 'LAUNCH_ASSET_STALE: select the exact current converted venue QR')
  return asset
}

export async function prospectLaunchAssetView(prospectVenueId: string) {
  try {
    const assets = await readProspectLaunchAssets(prospectVenueId)
    return { available: assets.map(venueLaunchAssetDescriptor), hold: assets.length ? null :
      'No current QR is available for an active converted venue. Open the venue QR kit after its visitor guide is ready.' }
  } catch {
    return { available: [], hold: 'Current venue QR could not be verified. Reload before selecting an attachment.' }
  }
}
