import { createHash } from 'node:crypto'
import { AnyVenueLaunchAssetSchema, type VenueLaunchAsset } from './venue-launch-asset'

export function parseVenueLaunchAsset(value: unknown): VenueLaunchAsset {
  const asset = AnyVenueLaunchAssetSchema.parse(value)
  const bytes = Buffer.from(asset.contentBase64, 'base64')
  if (
    bytes.toString('base64') !== asset.contentBase64 ||
    bytes.length !== asset.sizeBytes ||
    createHash('sha256').update(bytes).digest('hex') !== asset.sha256
  )
    throw new Error('LAUNCH_ASSET_BYTES_CHANGED: exact QR byte length and SHA-256 required')
  if (asset.schema === 'torchiko.venue-launch-asset/2') {
    const signature =
      asset.format === 'PNG'
        ? Buffer.from('89504e470d0a1a0a', 'hex')
        : Buffer.from('%PDF-', 'ascii')
    if (!bytes.subarray(0, signature.length).equals(signature))
      throw new Error('LAUNCH_ASSET_FORMAT_INVALID: content signature must match selected format')
  }
  return asset
}
export function parseVenueLaunchAttachments(value: unknown): VenueLaunchAsset[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1)
    throw new Error('LAUNCH_ASSET_SELECTION_INVALID: select at most one venue QR')
  return value.map(parseVenueLaunchAsset)
}
export function launchAttachmentsFromSnapshot(value: unknown): VenueLaunchAsset[] {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return parseVenueLaunchAttachments(record.launchAttachments)
}
export function launchAttachmentsSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(parseVenueLaunchAttachments(value)))
    .digest('hex')
}
