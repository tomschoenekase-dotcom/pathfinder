import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import {
  checkedLaunchAttachments,
  launchMimeBoundary,
  launchMimeParts,
  matchesLaunchAttachments,
} from './venue-launch-mime'

const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
const asset: VenueLaunchAsset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant',
  venueId: 'venue',
  release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://example.com/chat?source=qr',
  filename: 'venue-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  contentBase64: bytes.toString('base64'),
}

describe('venue launch MIME', () => {
  it('validates bytes, keeps boundary stable, and emits an exact base64 attachment', () => {
    expect(checkedLaunchAttachments([asset])).toEqual([asset])
    const boundary = launchMimeBoundary('operation', '<message@example.com>')
    expect(boundary).toBe(launchMimeBoundary('operation', '<message@example.com>'))
    const mime = launchMimeParts(`Hello\r\n--${boundary}\r\nInjected`, [asset], boundary)
    expect(mime).toContain(
      'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64',
    )
    expect(mime).not.toContain(`Hello\r\n--${boundary}`)
    const encodedText = mime
      .split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!
      .split(`\r\n--${boundary}`)[0]!
    expect(Buffer.from(encodedText.replaceAll('\r\n', ''), 'base64').toString('utf8')).toBe(
      `Hello\r\n--${boundary}\r\nInjected`,
    )
    expect(mime).toContain(`Content-Disposition: attachment; filename="venue-qr.svg"`)
    expect(mime).toContain(asset.contentBase64)
    expect(() => checkedLaunchAttachments([{ ...asset, sha256: 'b'.repeat(64) }])).toThrow()
  })

  it('accepts only the exact recovered attachment', () => {
    const recovered = {
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      contentBase64Url: bytes.toString('base64url'),
    }
    expect(matchesLaunchAttachments([asset], [recovered])).toBe(true)
    expect(matchesLaunchAttachments([asset], [{ ...recovered, filename: 'other.svg' }])).toBe(false)
    expect(
      matchesLaunchAttachments(
        [asset],
        [{ ...recovered, contentBase64Url: Buffer.from('changed').toString('base64url') }],
      ),
    ).toBe(false)
    expect(matchesLaunchAttachments([asset], [recovered, recovered])).toBe(false)
  })
})
