import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { renderVenueLaunchAsset } from './venue-launch-asset'

const source = {
  tenantId: 'museum-tenant',
  venueId: 'miniature-museum',
  venueName: 'Miniature Museum of Greater St. Louis',
  release: { kind: 'NATIVE' as const, id: 'published-release', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://guide.torchiko.com/miniaturemuseum/chat?source=qr',
}

describe('canonical venue launch assets', () => {
  it('retains source identity and exact bytes for each supported download', async () => {
    for (const format of ['SVG', 'PNG', 'PDF'] as const) {
      const asset = await renderVenueLaunchAsset(source, format)
      const bytes = Buffer.from(asset.contentBase64, 'base64')
      expect(asset.tenantId).toBe(source.tenantId)
      expect(asset.venueId).toBe(source.venueId)
      expect(asset.publicUrl).toBe(source.publicUrl)
      expect(asset.release).toEqual(source.release)
      expect(asset.filename.endsWith(`.${format.toLowerCase()}`)).toBe(true)
      expect(asset.sizeBytes).toBe(bytes.length)
      expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      if (format === 'PDF') expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-')
      if (format === 'PNG') expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      if (format === 'SVG') expect(bytes.toString('utf8')).toContain('<svg')
    }
  })
})
