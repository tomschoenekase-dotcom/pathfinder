import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fixture from './venue-qr-compatibility.json'
import { NayukiQrCode, NayukiQrSegment } from './venue-qr-nayuki'

describe('typed venue QR encoder compatibility', () => {
  const levels = {
    LOW: NayukiQrCode.Ecc.LOW,
    MEDIUM: NayukiQrCode.Ecc.MEDIUM,
    QUARTILE: NayukiQrCode.Ecc.QUARTILE,
    HIGH: NayukiQrCode.Ecc.HIGH,
  }

  it.each(fixture.records)('preserves $ecc version $minVersion mask $mask for $text', (entry) => {
    const level = levels[entry.ecc as keyof typeof levels]
    expect(level).toBeDefined()
    const qr = NayukiQrCode.encodeSegments(
      NayukiQrSegment.makeSegments(entry.text),
      level,
      entry.minVersion,
      entry.maxVersion,
      entry.mask,
      entry.boost,
    )
    expect(createHash('sha256').update(JSON.stringify(qr.getModules())).digest('hex')).toBe(
      entry.matrixSha256,
    )
  })

  it('retains invalid-version and capacity refusal', () => {
    const segments = NayukiQrSegment.makeSegments('x'.repeat(1000))
    expect(() => NayukiQrCode.encodeSegments(segments, levels.HIGH, 1, 1)).toThrow('Data too long')
    expect(() => NayukiQrCode.encodeSegments([], levels.MEDIUM, 0, 40)).toThrow('Invalid value')
    expect(() => NayukiQrCode.encodeSegments([], levels.MEDIUM, 1, 40, 8)).toThrow('Invalid value')
  })

  it('retains the light-module result for out-of-bounds public coordinates', () => {
    const qr = NayukiQrCode.encodeText('Torchiko', levels.MEDIUM)
    expect(qr.getModule(-1, 0)).toBe(false)
    expect(qr.getModule(qr.size, 0)).toBe(false)
    expect(qr.getModule(0, qr.size)).toBe(false)
  })
})
