import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { captureGuestEvidencePacket } from './guest-evidence-packet'
import {
  buildGuestAnswerEvidenceBundle,
  verifyGuestAnswerEvidenceBundle,
} from '@pathfinder/contracts/guest-answer-attribution-node'

const input = {
  staticPart: 'Rules. Profile.\n',
  directoryPrompt: 'Guide: only with an adult.\n',
  dynamicPart: 'Alert: schedule unknown. 🦉',
  mode: 'FULL' as const,
  loadStatus: 'READY',
  incomplete: false,
  rendererTruncated: false,
  updatedRecordCount: 0,
  retrievedCoveragePartial: false,
}

describe('exact dispatched guest evidence', () => {
  it('retains a whole20k body after worst-case JSON escaping without changing historical hashes', () => {
    const content = '\u0001'.repeat(19_998) + '"\\'
    const packet = captureGuestEvidencePacket(input)
    const bundleInput = {
      assistantResponse: 'A grounded answer.',
      staticSystemPrompt: packet.staticPart,
      dynamicSystemPrompt: packet.dynamicPart,
      sources: [
        {
          sourceId: 'knowledge:sample',
          kind: 'KNOWLEDGE' as const,
          label: 'Sample',
          snapshot: { content },
        },
      ],
    }
    const evidence = buildGuestAnswerEvidenceBundle(bundleInput)
    expect(evidence.sources[0]!.snapshot.length).toBeGreaterThan(100_000)
    expect(JSON.parse(evidence.sources[0]!.snapshot).content).toBe(content)
    expect(buildGuestAnswerEvidenceBundle(bundleInput)).toEqual(evidence)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: bundleInput.assistantResponse,
        evidence,
      }),
    ).toBe(true)
  })

  it('retains exact dispatch bytes, offsets and established cache blocks', () => {
    const packet = captureGuestEvidencePacket(input)
    expect(packet.system.map((block) => block.text).join('')).toBe(
      packet.staticPart + packet.dynamicPart,
    )
    expect(packet.staticPart).toBe(input.staticPart + input.directoryPrompt)
    expect(packet.system.map((block) => block.cache_control)).toEqual([
      undefined,
      { type: 'ephemeral' },
      undefined,
    ])
    for (const span of packet.contextPacket.sections) {
      const text = packet[span.part].slice(span.start, span.end)
      expect(createHash('sha256').update(text).digest('hex')).toBe(span.textSha256)
      expect(span.sourceVersion).toBeNull()
    }
    expect(packet.contextPacket.granularity).toBe('RENDERED_SECTIONS')
  })

  it('preserves absent-guide cache placement and truthful partial projection metadata', () => {
    const packet = captureGuestEvidencePacket({
      ...input,
      directoryPrompt: '',
      mode: 'DIRECTORY',
      incomplete: true,
      retrievedCoveragePartial: true,
    })
    expect(packet.system).toHaveLength(2)
    expect(packet.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(packet.contextPacket).toMatchObject({
      guideDetail: 'IDENTITY_OR_SUMMARY',
      incomplete: true,
      retrievedCoveragePartial: true,
    })
  })

  it('keeps a 120k guide and more than100 records without source-count truncation', () => {
    const directoryPrompt = Array.from(
      { length: 401 },
      (_, index) => `record${index}: conditions preserved\n`,
    ).join('')
    const packet = captureGuestEvidencePacket({ ...input, directoryPrompt })
    expect(packet.staticPart).toContain('record400: conditions preserved')
    expect(
      captureGuestEvidencePacket({ ...input, directoryPrompt: 'x'.repeat(120_000) }).staticPart
        .length,
    ).toBe(120_000 + input.staticPart.length)
  })

  it('rejects oversized receipts instead of silently clipping factual conditions', () => {
    expect(() =>
      captureGuestEvidencePacket({
        ...input,
        staticPart: 's'.repeat(40_001),
        directoryPrompt: 'g'.repeat(120_000),
      }),
    ).toThrow('retained prompt boundary')
    expect(() =>
      captureGuestEvidencePacket({ ...input, dynamicPart: 'd'.repeat(150_001) }),
    ).toThrow('retained prompt boundary')
  })

  it('persists the exact large guide in the existing bundle and detects altered conditions', () => {
    const packet = captureGuestEvidencePacket({
      ...input,
      directoryPrompt: 'x'.repeat(119_950) + '\nOnly with an adult.',
    })
    const evidence = buildGuestAnswerEvidenceBundle({
      assistantResponse: 'Only with an adult.',
      staticSystemPrompt: packet.staticPart,
      dynamicSystemPrompt: packet.dynamicPart,
      sources: [
        {
          sourceId: 'venue:sample',
          kind: 'VENUE_PROFILE',
          label: 'Sample',
          snapshot: { contextPacket: packet.contextPacket },
        },
      ],
    })
    expect(evidence.system.staticPart).toBe(
      packet.system
        .slice(0, 2)
        .map((block) => block.text)
        .join(''),
    )
    expect(
      verifyGuestAnswerEvidenceBundle({ assistantResponse: 'Only with an adult.', evidence }),
    ).toBe(true)
    expect(
      verifyGuestAnswerEvidenceBundle({
        assistantResponse: 'Only with an adult.',
        evidence: {
          ...evidence,
          system: {
            ...evidence.system,
            staticPart: evidence.system.staticPart.replace(
              'Only with an adult.',
              'No adult required.',
            ),
          },
        },
      }),
    ).toBe(false)
  })
})
