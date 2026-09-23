import { createHash, timingSafeEqual } from 'node:crypto'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { parseVenueLaunchAttachments } from '@pathfinder/contracts/venue-launch-asset-node'

export type RecoveredLaunchAttachment = Readonly<{
  filename: string
  mimeType: string
  sizeBytes: number
  contentBase64Url: string
}>

/** Validate the immutable snapshot before a provider credential is leased. */
export function checkedLaunchAttachments(value: unknown): readonly VenueLaunchAsset[] {
  return parseVenueLaunchAttachments(value)
}

export function launchMimeBoundary(operationId: string, rfcMessageId: string): string {
  return `pathfinder-venue-${createHash('sha256')
    .update(JSON.stringify([operationId, rfcMessageId]))
    .digest('hex')
    .slice(0, 40)}`
}

export function launchMimeParts(
  textBody: string,
  assets: readonly VenueLaunchAsset[],
  boundary: string,
): string {
  if (assets.length !== 1) throw new Error('Exactly one venue QR is required for multipart MIME')
  const asset = assets[0]!
  const text =
    Buffer.from(textBody, 'utf8')
      .toString('base64')
      .match(/.{1,76}/gu)
      ?.join('\r\n') ?? ''
  const content = asset.contentBase64.match(/.{1,76}/gu)?.join('\r\n') ?? ''
  return [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    text,
    `--${boundary}`,
    `Content-Type: ${asset.mimeType}; name="${asset.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${asset.filename}"`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/** Only an exact ordered byte match can recover an uncertain accepted send. */
export function matchesLaunchAttachments(
  expected: readonly VenueLaunchAsset[],
  actual: readonly RecoveredLaunchAttachment[] | undefined,
): boolean {
  if ((actual?.length ?? 0) !== expected.length) return false
  return expected.every((asset, index) => {
    const candidate = actual?.[index]
    if (
      !candidate ||
      candidate.filename !== asset.filename ||
      candidate.mimeType !== asset.mimeType ||
      candidate.sizeBytes !== asset.sizeBytes
    )
      return false
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(candidate.contentBase64Url)) return false
    const bytes = Buffer.from(candidate.contentBase64Url, 'base64url')
    if (
      bytes.toString('base64url') !== candidate.contentBase64Url.replace(/=+$/u, '') ||
      bytes.length !== asset.sizeBytes
    )
      return false
    const digest = createHash('sha256').update(bytes).digest()
    return timingSafeEqual(digest, Buffer.from(asset.sha256, 'hex'))
  })
}
