import { createHash } from 'node:crypto'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import { VenueLaunchAssetSelectionSchema } from '@pathfinder/contracts/venue-launch-asset'
const mock = vi.hoisted(() => ({ links: vi.fn(), asset: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: { $transaction: (fn: (tx: unknown) => unknown) => fn({}) },
  readProspectLaunchLinks: mock.links,
  salesHash: (value: unknown) => JSON.stringify(value),
  ProspectSalesError: class extends Error { constructor(_code: string, message: string) { super(message) } },
}))
vi.mock('./lib/venue-launch-asset', () => ({ resolveVenueLaunchAsset: mock.asset }))
import { selectProspectLaunchAsset, prospectLaunchAssetView } from './prospect-launch-assets'
const publicUrl = 'https://guide.example.com/venue/chat?source=qr'
const bytes = Buffer.from(renderVenueQrSvg(publicUrl))
const asset = { schema: 'torchiko.venue-launch-asset/1', tenantId: 'tenant', venueId: 'venue',
  release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) }, publicUrl,
  filename: 'venue-qr.svg', mimeType: 'image/svg+xml', sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') }
const selection = { tenantId: asset.tenantId, venueId: asset.venueId, release: asset.release,
  publicUrl: asset.publicUrl, sha256: asset.sha256 }
describe('current server QR selection boundary', () => {
  beforeEach(() => { mock.links.mockResolvedValue([{tenantId:'tenant',venueId:'venue'}]); mock.asset.mockResolvedValue(asset) })
  it('returns exact server bytes and exposes only a descriptor to the operator or agent', async () => {
    await expect(selectProspectLaunchAsset('prospect', selection as never)).resolves.toEqual(asset)
    const view = await prospectLaunchAssetView('prospect')
    expect(view.available[0]).toMatchObject(selection)
    expect(view.available[0]).not.toHaveProperty('contentBase64')
  })
  it.each(['sha256', 'publicUrl', 'tenantId', 'venueId'] as const)('rejects a substituted %s', async (field) => {
    const value = field === 'sha256' ? 'f'.repeat(64) : field === 'publicUrl' ? 'https://elsewhere.example.com/chat?source=qr' : 'other'
    await expect(selectProspectLaunchAsset('prospect', {...selection, [field]:value} as never)).rejects.toThrow('LAUNCH_ASSET_STALE')
  })
  it('rejects uploaded bytes and a prior source release', async () => {
    expect(VenueLaunchAssetSelectionSchema.safeParse({...selection,contentBase64:asset.contentBase64}).success).toBe(false)
    await expect(selectProspectLaunchAsset('prospect', {...selection,release:{...selection.release,revisionSha256:'b'.repeat(64)}} as never)).rejects.toThrow('LAUNCH_ASSET_STALE')
  })
  it('holds missing and over-bound converted destinations', async () => {
    mock.links.mockResolvedValue([])
    await expect(selectProspectLaunchAsset('prospect', selection as never)).rejects.toThrow('LAUNCH_ASSET_STALE')
    mock.links.mockResolvedValue(Array.from({length:9},()=>({tenantId:'tenant',venueId:'venue'})))
    expect((await prospectLaunchAssetView('prospect')).available).toEqual([])
  })
})
