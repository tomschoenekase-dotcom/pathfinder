import { createHash } from 'node:crypto'
import jsQR from 'jsqr'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const source = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({ resolveVenueLaunchSource: source }))

import { resolveVenueLaunchAsset } from '../../../packages/api/src/lib/venue-launch-asset'

const publicUrl = 'https://guide.example.com/museum/chat?source=qr'
const input = {
  client: {} as never,
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  configuredOrigin: 'https://guide.example.com',
}

describe('server venue launch QR asset', () => {
  beforeEach(() => {
    source.mockReset()
    source.mockResolvedValue({
      tenantId: input.tenantId,
      venueId: input.venueId,
      venueName: 'Museum',
      publicUrl,
      release: { kind: 'LEGACY', id: 'legacy:venue-a', revisionSha256: 'a'.repeat(64) },
    })
  })

  it('produces deterministic verified SVG bytes that decode to the exact public URL', async () => {
    const first = await resolveVenueLaunchAsset(input)
    const second = await resolveVenueLaunchAsset(input)
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    const bytes = Buffer.from(first!.contentBase64, 'base64')
    expect(bytes.byteLength).toBe(first!.sizeBytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(first!.sha256)
    expect(bytes.toString('utf8')).toMatch(/^<svg\b/u)
    const { data, info } = await sharp(bytes)
      .resize(832, 832, { kernel: sharp.kernel.nearest })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const decoded = jsQR(
      new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      info.width,
      info.height,
      { inversionAttempts: 'attemptBoth' },
    )
    expect(decoded?.data).toBe(publicUrl)
    expect(first!.filename).toMatch(/^torchiko-museum-[a-f0-9]{12}-qr\.svg$/u)
  })

  it('does not produce an attachment without a current source', async () => {
    source.mockResolvedValue(null)
    await expect(resolveVenueLaunchAsset(input)).resolves.toBeNull()
  })
})
