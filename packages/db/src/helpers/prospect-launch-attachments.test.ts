import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateVenueQrPng } from '@pathfinder/contracts/venue-qr-print'
import { renderVenueQrSvg } from '@pathfinder/contracts/venue-qr-svg'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

const mock = vi.hoisted(() => ({ links: vi.fn(), source: vi.fn() }))
vi.mock('../client', () => ({ db: { prospectLocationConversion: { findMany: mock.links } } }))
vi.mock('./venue-launch-source', () => ({ resolveVenueLaunchSource: mock.source }))

import {
  prospectOperationalContentHash,
  readProspectLaunchLinks,
  requireCurrentProspectLaunchAttachments,
  requireSameLaunchAttachments,
} from './prospect-launch-attachments'

const publicUrl = 'https://guide.example.com/venue/chat?source=qr'
const release = { kind: 'NATIVE' as const, id: 'release-1', revisionSha256: 'a'.repeat(64) }
const svgBytes = Buffer.from(renderVenueQrSvg(publicUrl), 'utf8')
const pngBytes = Buffer.from(generateVenueQrPng(publicUrl).bytes)
const asset = (bytes: Buffer, format: 'SVG' | 'PNG' = 'SVG'): VenueLaunchAsset =>
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
        format: 'PNG',
        generatorVersion: 'qr-print-v1',
        filename: 'venue-qr.png',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      }

function client(links = [{ tenantId: 'tenant-1', venueId: 'venue-1' }]) {
  return { prospectLocationConversion: { findMany: vi.fn().mockResolvedValue(links) } }
}

describe('prospect launch attachment authority', () => {
  beforeEach(() => {
    mock.links.mockReset()
    mock.source.mockReset()
    mock.links.mockResolvedValue([{ tenantId: 'tenant-1', venueId: 'venue-1' }])
    mock.source.mockResolvedValue({ tenantId: 'tenant-1', venueId: 'venue-1', publicUrl, release })
  })

  it('reads only active relation-owned links with a bounded overflow sentinel', async () => {
    const records = client() as unknown as {
      prospectLocationConversion: { findMany: ReturnType<typeof vi.fn> }
    }
    mock.links.mockImplementation(records.prospectLocationConversion.findMany)
    await readProspectLaunchLinks('prospect-venue-1', records as never)
    expect(records.prospectLocationConversion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          prospectVenueId: 'prospect-venue-1',
          status: 'ACTIVE',
          endedAt: null,
          relationship: { status: 'ACTIVE', endedAt: null },
        },
        take: 9,
      }),
    )
  })

  it.each([[asset(svgBytes)], [asset(pngBytes, 'PNG')]])(
    'accepts current canonical asset bytes',
    async (candidate) => {
      await expect(
        requireCurrentProspectLaunchAttachments('prospect-venue-1', [candidate], {
          client: client() as never,
        }),
      ).resolves.toEqual([candidate])
    },
  )

  it('preserves no-attachment behavior without requiring a conversion lookup', async () => {
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [], {
        client: client([]) as never,
      }),
    ).resolves.toEqual([])
    expect(mock.links).not.toHaveBeenCalled()
    const textOnlyHash = () => createHash('sha256').update('to\nsubject\nbody\nhtml').digest('hex')
    expect(prospectOperationalContentHash('to', 'subject', 'body', 'html', {})).toBe(textOnlyHash())
  })

  it('rejects mismatched active conversion, stale source, and tampered bytes', async () => {
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [asset(svgBytes)], {
        client: client([{ tenantId: 'other-tenant', venueId: 'venue-1' }]) as never,
      }),
    ).rejects.toThrow(/active converted venue/u)
    mock.source.mockResolvedValue({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      publicUrl,
      release: { ...release, id: 'old' },
    })
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [asset(svgBytes)], {
        client: client() as never,
      }),
    ).rejects.toThrow(/stale/u)
    const tampered = {
      ...asset(svgBytes),
      contentBase64: Buffer.from('wrong').toString('base64'),
      sizeBytes: Buffer.from('wrong').length,
      sha256: createHash('sha256').update('wrong').digest('hex'),
    }
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [tampered], {
        client: client() as never,
      }),
    ).rejects.toThrow(/canonical QR renderer/u)
  })

  it('rejects unsupported PDF canonical verification and changed reviewed attachments', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fixture')
    const pdf: VenueLaunchAsset = {
      schema: 'torchiko.venue-launch-asset/2',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      release,
      publicUrl,
      format: 'PDF',
      generatorVersion: 'qr-print-v1',
      filename: 'venue-qr.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBytes.length,
      sha256: createHash('sha256').update(pdfBytes).digest('hex'),
      contentBase64: pdfBytes.toString('base64'),
    }
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [pdf], {
        client: client() as never,
      }),
    ).rejects.toThrow(/canonical bytes/i)
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [pdf], {
        client: client() as never,
        verifiedCurrentPrintAssets: [pdf],
      }),
    ).resolves.toEqual([pdf])
    await expect(
      requireCurrentProspectLaunchAttachments('prospect-venue-1', [pdf], {
        client: client() as never,
        verifiedCurrentPrintAssets: [
          { ...pdf, contentBase64: Buffer.from('%PDF-1.4 different').toString('base64') },
        ],
      }),
    ).rejects.toThrow(/canonical bytes/i)
    expect(() =>
      requireSameLaunchAttachments(
        { launchAttachments: [asset(svgBytes)] },
        { launchAttachments: [asset(pngBytes, 'PNG')] },
      ),
    ).toThrow(/changed after review/u)
    expect(() => requireSameLaunchAttachments({}, {})).not.toThrow()
  })
})
