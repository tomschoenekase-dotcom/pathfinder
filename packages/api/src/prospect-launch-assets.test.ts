import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateVenueQrPng } from '@pathfinder/contracts/venue-qr-print'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

const mock = vi.hoisted(() => ({ links: vi.fn(), resolve: vi.fn(), transaction: vi.fn() }))
vi.mock('@pathfinder/db', () => ({
  db: { $transaction: mock.transaction },
  readProspectLaunchLinks: mock.links,
}))
vi.mock('./lib/venue-launch-asset', () => ({ resolveVenueLaunchAsset: mock.resolve }))

import {
  prospectLaunchAssetView,
  readProspectLaunchAssets,
  resolveVerifiedCurrentPrintAssets,
  selectProspectLaunchAsset,
} from './prospect-launch-assets'

const publicUrl = 'https://guide.example.com/venue/chat?source=qr'
const release = { kind: 'NATIVE' as const, id: 'release-1', revisionSha256: 'a'.repeat(64) }
const svgBytes = Buffer.from(renderVenueQrSvg(publicUrl))
const pngBytes = Buffer.from(generateVenueQrPng(publicUrl).bytes)
const pdfBytes = Buffer.from('%PDF-1.4 fixture')
const makeAsset = (bytes: Buffer, format: 'SVG' | 'PNG' | 'PDF' = 'SVG'): VenueLaunchAsset =>
  format === 'SVG'
    ? {
        schema: 'torchiko.venue-launch-asset/1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        release,
        publicUrl,
        filename: 'venue-qr.svg',
        mimeType: 'image/svg+xml',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      }
    : {
        schema: 'torchiko.venue-launch-asset/2',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        release,
        publicUrl,
        format,
        generatorVersion: 'qr-print-v1',
        filename: format === 'PNG' ? 'venue-qr.png' : 'venue-qr.pdf',
        mimeType: format === 'PNG' ? 'image/png' : 'application/pdf',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      }

describe('prospect launch asset selection', () => {
  beforeEach(() => {
    mock.links.mockReset().mockResolvedValue([{ tenantId: 'tenant-1', venueId: 'venue-1' }])
    mock.resolve
      .mockReset()
      .mockImplementation(({ format }: { format: 'SVG' | 'PNG' | 'PDF' }) =>
        makeAsset(format === 'SVG' ? svgBytes : format === 'PNG' ? pngBytes : pdfBytes, format),
      )
    mock.transaction
      .mockReset()
      .mockImplementation((callback: (client: object) => unknown) => callback({}))
  })

  it('resolves only bounded active conversion links under repeatable read', async () => {
    await expect(readProspectLaunchAssets('prospect-venue-1')).resolves.toEqual([
      makeAsset(svgBytes),
      makeAsset(pngBytes, 'PNG'),
      makeAsset(pdfBytes, 'PDF'),
    ])
    expect(mock.links).toHaveBeenCalledWith('prospect-venue-1')
    expect(mock.resolve.mock.calls.map(([input]) => input.format)).toEqual(['SVG', 'PNG', 'PDF'])
    expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
    mock.links.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => ({
        tenantId: 'tenant-1',
        venueId: `venue-${index}`,
      })),
    )
    await expect(readProspectLaunchAssets('prospect-venue-1')).rejects.toThrow(
      'LAUNCH_ASSET_SCOPE_EXCEEDS_BOUND',
    )
  })

  it('matches PNG format and generator version exactly and returns no bytes in the descriptor view', async () => {
    const selected = await selectProspectLaunchAsset('prospect-venue-1', {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release,
      publicUrl,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      format: 'PNG',
      generatorVersion: 'qr-print-v1',
    })
    expect(selected).toEqual(makeAsset(pngBytes, 'PNG'))
    const view = await prospectLaunchAssetView('prospect-venue-1')
    expect(view.available.find((asset) => asset.mimeType === 'image/png')).toMatchObject({
      format: 'PNG',
      generatorVersion: 'qr-print-v1',
    })
    expect(view.available.every((asset) => !('contentBase64' in asset))).toBe(true)
    await expect(
      selectProspectLaunchAsset('prospect-venue-1', {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        release,
        publicUrl,
        sha256: createHash('sha256').update(pngBytes).digest('hex'),
        format: 'PNG',
        generatorVersion: 'qr-print-v2',
      }),
    ).rejects.toThrow('LAUNCH_ASSET_STALE')
  })

  it('selects a current PDF only when the exact format and generator version match', async () => {
    const pdf = makeAsset(pdfBytes, 'PDF')
    mock.resolve.mockResolvedValue(pdf)
    const selection = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release,
      publicUrl,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
      format: 'PDF' as const,
      generatorVersion: 'qr-print-v1',
    }
    await expect(selectProspectLaunchAsset('prospect-venue-1', selection)).resolves.toMatchObject({
      format: 'PDF',
      generatorVersion: 'qr-print-v1',
      mimeType: 'application/pdf',
    })
    await expect(
      selectProspectLaunchAsset('prospect-venue-1', { ...selection, format: 'PNG' }),
    ).rejects.toThrow('LAUNCH_ASSET_STALE')
    await expect(
      resolveVerifiedCurrentPrintAssets('prospect-venue-1', { launchAttachments: [pdf] }),
    ).resolves.toEqual([{ prospectVenueId: 'prospect-venue-1', asset: pdf }])
  })

  it('rejects stale identity and fails closed when no active current asset exists', async () => {
    mock.resolve.mockResolvedValue(makeAsset(svgBytes))
    await expect(
      selectProspectLaunchAsset('prospect-venue-1', {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        release,
        publicUrl,
        sha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow('LAUNCH_ASSET_STALE')
    mock.links.mockResolvedValue([])
    await expect(prospectLaunchAssetView('prospect-venue-1')).resolves.toMatchObject({
      available: [],
      hold: expect.stringContaining('No current QR'),
    })
  })
})
