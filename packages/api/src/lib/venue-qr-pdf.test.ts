import { describe, expect, it } from 'vitest'
import { generateVenueQrPng } from '@pathfinder/contracts/venue-qr-print'
import { renderVenueQrPdf } from './venue-qr-pdf'

const publicUrl = 'https://guide.torchiko.com/miniaturemuseum/chat?source=qr'
const qr = generateVenueQrPng(publicUrl)

describe('renderVenueQrPdf', () => {
  it('writes deterministic single-page Letter PDFs around the canonical QR PNG', async () => {
    const input = { venueName: 'Museum of World Cultures', publicUrl, qrPngBytes: qr.bytes }
    const [first, second] = await Promise.all([renderVenueQrPdf(input), renderVenueQrPdf(input)])

    expect(first.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4')
    expect(first.equals(second)).toBe(true)
    expect(first.includes(Buffer.from('/MediaBox [0 0 612 792]'))).toBe(true)
    expect(first.includes(Buffer.from('/Count 1'))).toBe(true)
    expect(first.includes(Buffer.from('/CreationDate'))).toBe(false)
    expect(first.includes(Buffer.from('/Instruction 6 0 R'))).toBe(true)
    expect(first.includes(Buffer.from('/Brand 8 0 R'))).toBe(true)
    expect(first.includes(Buffer.from('/Title (Torchiko QR visitor guide)'))).toBe(true)
    expect(first.includes(Buffer.from('/Subject (Scan to open the visitor guide)'))).toBe(true)
    expect(first.indexOf(Buffer.from(qr.bytes.subarray(41, qr.bytes.length - 16)))).toBeGreaterThan(
      -1,
    )
  })

  it('renders the current Miniature Museum guide URL', async () => {
    const pdf = await renderVenueQrPdf({
      venueName: 'Miniature Museum',
      publicUrl,
      qrPngBytes: qr.bytes,
    })
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4')
    expect(pdf.includes(Buffer.from('/Subject (Scan to open the visitor guide)'))).toBe(true)
  })

  it.each([
    ['long Latin', 'The Grand Museum of Natural History and World Cultures — Main Entrance'],
    ['Arabic', 'متحف الحضارات العالمية'],
    ['CJK', '東京国立博物館 中國歷史文化展览馆'],
  ])('renders %s venue names without substituting characters', async (_label, venueName) => {
    const pdf = await renderVenueQrPdf({ venueName, publicUrl, qrPngBytes: qr.bytes })
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4')
    expect(pdf.length).toBeGreaterThan(10_000)
  })

  it('rejects missing names, non-HTTPS links, and unsupported QR PNGs', async () => {
    await expect(
      renderVenueQrPdf({ venueName: ' ', publicUrl, qrPngBytes: qr.bytes }),
    ).rejects.toThrow('Venue name must contain')
    await expect(
      renderVenueQrPdf({
        venueName: 'Museum',
        publicUrl: 'http://example.com',
        qrPngBytes: qr.bytes,
      }),
    ).rejects.toThrow('Public URL must be HTTPS')
    await expect(
      renderVenueQrPdf({ venueName: 'Museum', publicUrl, qrPngBytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow('not a valid canonical PNG')
  })
})
