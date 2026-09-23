import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { parseVenueLaunchAsset } from './venue-launch-asset-node'
import { generateVenueQrPng } from './venue-qr-print'

const publicUrl = 'https://guide.torchiko.com/miniaturemuseum/chat?source=qr'
const release = { kind: 'NATIVE' as const, id: 'release-1', revisionSha256: 'a'.repeat(64) }
const scope = { tenantId: 'tenant-1', venueId: 'venue-1', release, publicUrl }

function metadata(bytes: Buffer) {
  return {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  }
}

describe('venue launch attachment versions', () => {
  it('keeps exact legacy SVG bytes readable', () => {
    const bytes = Buffer.from('<svg><path d="M0 0h1v1H0z"/></svg>')
    expect(
      parseVenueLaunchAsset({
        schema: 'torchiko.venue-launch-asset/1',
        ...scope,
        filename: 'torchiko-venue-qr.svg',
        mimeType: 'image/svg+xml',
        ...metadata(bytes),
      }).schema,
    ).toBe('torchiko.venue-launch-asset/1')
  })

  it('accepts canonical PNG and rejects a mismatched MIME or changed bytes', () => {
    const bytes = Buffer.from(generateVenueQrPng(publicUrl).bytes)
    const asset = {
      schema: 'torchiko.venue-launch-asset/2',
      ...scope,
      format: 'PNG',
      generatorVersion: 'qr-print-v1',
      filename: 'torchiko-venue-qr.png',
      mimeType: 'image/png',
      ...metadata(bytes),
    }
    expect(parseVenueLaunchAsset(asset).schema).toBe('torchiko.venue-launch-asset/2')
    expect(() => parseVenueLaunchAsset({ ...asset, mimeType: 'application/pdf' })).toThrow()
    expect(() =>
      parseVenueLaunchAsset({ ...asset, ...metadata(Buffer.from('not a PNG')) }),
    ).toThrow('LAUNCH_ASSET_FORMAT_INVALID')
  })
})
