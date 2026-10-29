import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { captureGuestEvidencePacket } from './guest-evidence-packet'

const input = {
  staticPart: 'Trusted rules. Answer in English.\n',
  directoryPrompt:
    '<untrusted_venue_data>\nJuniper Hall: entry $4; workshop extra.\n</untrusted_venue_data>\n',
  dynamicPart: 'Current date and question context.',
  mode: 'FULL' as const,
  loadStatus: 'READY',
  incomplete: false,
  rendererTruncated: false,
  updatedRecordCount: 0,
  retrievedCoveragePartial: false,
}

describe('optional stable venue prefix', () => {
  it('keeps default and unknown settings byte-identical', () => {
    const baseline = captureGuestEvidencePacket(input, {})
    for (const value of ['off', '', 'on', 'unknown']) {
      expect(captureGuestEvidencePacket(input, { GUEST_CHAT_CACHE_ORDER: value })).toEqual(baseline)
    }
  })

  it('moves the complete guide before rules without dropping or editing any text', () => {
    const packet = captureGuestEvidencePacket(input, { GUEST_CHAT_CACHE_ORDER: 'venue-first' })
    expect(packet.system.map((block) => block.text)).toEqual([
      input.directoryPrompt,
      input.staticPart,
      input.dynamicPart,
    ])
    expect(packet.staticPart).toBe(input.directoryPrompt + input.staticPart)
    expect(packet.system.map((block) => block.text).join('')).toBe(
      packet.staticPart + packet.dynamicPart,
    )
    expect(packet.contextPacket.sections.map((section) => section.id)).toEqual([
      'guide',
      'instructions-and-profile',
      'turn-context',
    ])
    for (const section of packet.contextPacket.sections) {
      expect(
        createHash('sha256')
          .update(packet[section.part].slice(section.start, section.end))
          .digest('hex'),
      ).toBe(section.textSha256)
    }
  })

  it('keeps the venue prefix stable when request-specific language guidance changes', () => {
    const env = { GUEST_CHAT_CACHE_ORDER: 'venue-first' }
    const english = captureGuestEvidencePacket(input, env)
    const spanish = captureGuestEvidencePacket(
      { ...input, staticPart: 'Trusted rules. Answer in Spanish.\n' },
      env,
    )
    expect(english.system[0]?.text).toBe(input.directoryPrompt)
    expect(spanish.system[0]).toEqual(english.system[0])
    expect(spanish.system[1]?.text).not.toBe(english.system[1]?.text)
  })

  it('leaves absent-guide packets unchanged and preserves size limits', () => {
    const withoutGuide = { ...input, directoryPrompt: '', mode: 'NONE' as const }
    expect(
      captureGuestEvidencePacket(withoutGuide, { GUEST_CHAT_CACHE_ORDER: 'venue-first' }),
    ).toEqual(captureGuestEvidencePacket(withoutGuide, {}))
    expect(() =>
      captureGuestEvidencePacket(
        { ...input, directoryPrompt: 'x'.repeat(160_001) },
        { GUEST_CHAT_CACHE_ORDER: 'venue-first' },
      ),
    ).toThrow('retained prompt boundary')
  })
})
