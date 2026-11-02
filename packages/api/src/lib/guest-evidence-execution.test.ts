import { describe, expect, it } from 'vitest'
import { GuestEvidenceExecutionSchema } from '@pathfinder/contracts/guest-answer-attribution'
import { assembleGuestEvidence } from './guest-evidence-assembly'
import { guestAnswerShape } from './guest-evidence-answer-shape'
import { guestEvidenceExecution } from './guest-evidence-execution'

function assembly() {
  return assembleGuestEvidence({
    question: 'What is the Cloud Pass?',
    visitorMessages: ['What is the Cloud Pass?'],
    shape: guestAnswerShape('What is the Cloud Pass?'),
    records: [
      {
        ref: 'knowledge:pass',
        title: 'Cloud Pass',
        content: 'Kind: admission offer\nMust mention: Redeeming the Cloud Pass ends entry today.',
        version: 'r1',
      },
    ],
    retrievedRefs: [],
    previous: null,
    unavailableRefs: [],
    coverage: { mode: 'FULL', incomplete: false, loadFailed: false, retrievalPartial: false },
    escape: (text) => text,
  })
}

describe('guest evidence execution receipt', () => {
  it('captures actual versions, source refs and notice counts without record or answer text', () => {
    const result = guestEvidenceExecution({
      assembly: assembly(),
      mode: 'luna',
      noticesSupplied: 1,
    })
    expect(result).toMatchObject({
      mode: 'luna',
      records: [{ ref: 'knowledge:pass', version: 'r1', purpose: 'rendered' }],
      recordsTruncated: false,
      recordCount: 1,
      noticeDelivery: 'prompt',
      noticesSupplied: 1,
      noticesChecked: 0,
      noticesAppended: 0,
    })
    expect(result).not.toHaveProperty('noticeCheckerVersion')
    expect(JSON.stringify(result)).not.toContain('Redeeming')
    expect(GuestEvidenceExecutionSchema.safeParse({ ...result, answer: 'An answer' }).success).toBe(
      false,
    )
    // A prompt-delivered receipt can never claim a server-side append.
    expect(
      GuestEvidenceExecutionSchema.safeParse({ ...result, noticesChecked: 1, noticesAppended: 1 })
        .success,
    ).toBe(false)
  })

  it('still reads older append-era receipts', () => {
    const older = {
      ...guestEvidenceExecution({ assembly: assembly(), mode: 'on', noticesSupplied: 1 }),
      noticeCheckerVersion: 'guest-required-notices-v1',
      noticesChecked: 1,
      noticesAppended: 1,
    }
    delete (older as Record<string, unknown>).noticeDelivery
    delete (older as Record<string, unknown>).noticesSupplied
    expect(GuestEvidenceExecutionSchema.safeParse(older).success).toBe(true)
    expect(GuestEvidenceExecutionSchema.safeParse({ ...older, noticesAppended: 2 }).success).toBe(
      false,
    )
  })

  it('marks bounded source coverage and gives rendered purpose precedence for duplicate refs', () => {
    const original = assembly()
    original.supporting = Array.from({ length: 110 }, (_, index) => ({
      ref: `knowledge:scope-${index}`,
      title: 'Scope',
      content: 'Untrusted text',
      version: null,
    }))
    original.supporting.push(original.rendered[0]!)
    const result = guestEvidenceExecution({ assembly: original, mode: 'on', noticesSupplied: 0 })
    expect(result).toMatchObject({ recordCount: 111, recordsTruncated: true })
    expect(result.records).toHaveLength(100)
    expect(result.records[0]).toEqual({ ref: 'knowledge:pass', version: 'r1', purpose: 'rendered' })
    expect(
      GuestEvidenceExecutionSchema.safeParse({ ...result, recordsTruncated: false }).success,
    ).toBe(false)
    original.supporting = [original.rendered[0]!]
    const duplicate = guestEvidenceExecution({ assembly: original, mode: 'on', noticesSupplied: 0 })
    expect(duplicate.records).toEqual([
      { ref: 'knowledge:pass', version: 'r1', purpose: 'rendered' },
    ])
    expect(duplicate.evidenceSha256).toBe(result.evidenceSha256)
    original.data += ' changed'
    expect(
      guestEvidenceExecution({ assembly: original, mode: 'on', noticesSupplied: 0 }).evidenceSha256,
    ).not.toBe(result.evidenceSha256)
  })
})
