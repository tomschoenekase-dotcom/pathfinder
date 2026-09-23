import { z } from 'zod'

export const VENUE_LAUNCH_ASSET_MAX_BYTES = 131_072
const id = z.string().min(1).max(191)
const sha = z.string().regex(/^[a-f0-9]{64}$/u)
/** A server-produced venue QR, never an arbitrary upload or fetch instruction. */
export const VenueLaunchAssetSchema = z.object({
  schema: z.literal('torchiko.venue-launch-asset/1'),
  tenantId: id,
  venueId: id,
  release: z.object({
    kind: z.enum(['NATIVE', 'LEGACY']),
    id,
    revisionSha256: sha,
  }).strict(),
  publicUrl: z.string().url().max(2000).refine((value) => {
    let url: URL
    try { url = new URL(value) } catch { return false }
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      url.pathname.endsWith('/chat') && url.search === '?source=qr'
  }, 'Exact public HTTPS venue QR destination required'),
  filename: z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}\.svg$/u),
  mimeType: z.literal('image/svg+xml'),
  sizeBytes: z.number().int().min(1).max(VENUE_LAUNCH_ASSET_MAX_BYTES),
  sha256: sha,
  contentBase64: z.string().min(4).max(Math.ceil(VENUE_LAUNCH_ASSET_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict()
export type VenueLaunchAsset = z.infer<typeof VenueLaunchAssetSchema>
export const VenueLaunchAssetSelectionSchema = VenueLaunchAssetSchema.pick({
  tenantId: true, venueId: true, release: true, publicUrl: true, sha256: true,
})
export type VenueLaunchAssetSelection = z.infer<typeof VenueLaunchAssetSelectionSchema>
export type VenueLaunchAssetDescriptor = Omit<VenueLaunchAsset, 'contentBase64'>
export function venueLaunchAssetDescriptor(asset: VenueLaunchAsset): VenueLaunchAssetDescriptor {
  const { contentBase64: _bytes, ...descriptor } = asset
  return descriptor
}

