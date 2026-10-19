import { describe, expect, it } from 'vitest'

import {
  GUEST_ANSWER_CHECK_CLOSE,
  GUEST_ANSWER_CHECK_INSTRUCTION,
  GUEST_ANSWER_CHECK_OPEN,
  GuestAnswerCheckFormatError,
  appendGuestAnswerCheckInstruction,
  createGuestAnswerCheckStreamGate,
  guestAnswerCheckMode,
  isGuestAnswerCheckEnabled,
  splitGuestAnswerCheck,
  summarizeGuestAnswerCheck,
} from './guest-answer-check'

const check = JSON.stringify({
  decisions: [
    {
      question: 'buy at 19:30',
      disposition: 'NO',
      conditions: [],
      missingFacts: [],
      evidenceQuotes: ['Ticket sales end at 19:15.'],
      visitorFactQuotes: ['19:30'],
    },
  ],
})
const answer = 'No. Ticket sales end at 7:15 p.m., so 7:30 is too late to buy one.'
const reply = `${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}\n${answer}`

async function streamed(chunks: string[]) {
  const out: string[] = []
  const push = createGuestAnswerCheckStreamGate((delta) => {
    out.push(delta)
  })
  for (const chunk of chunks) await push(chunk)
  return out.join('')
}

describe('guest answer check mode', () => {
  it('is off unless explicitly selected, including for unknown values', () => {
    expect(guestAnswerCheckMode({})).toBe('off')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: 'yes' })).toBe('off')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: ' Economy ' })).toBe('economy')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: 'all' })).toBe('all')
  })

  it('selects economy-tier primary models only in economy mode', () => {
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-luna')).toBe(true)
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-sol')).toBe(false)
    expect(isGuestAnswerCheckEnabled('all', 'guest-chat-sol')).toBe(true)
    expect(isGuestAnswerCheckEnabled('off', 'guest-chat-luna')).toBe(false)
    expect(isGuestAnswerCheckEnabled('all', 'not-a-model')).toBe(false)
    expect(isGuestAnswerCheckEnabled('all', undefined)).toBe(false)
  })

  it('appends the instruction after the existing dynamic text without changing it', () => {
    const dynamic = 'DATE: x\n\nEND OF UNTRUSTED RETRIEVED DATA.'
    const appended = appendGuestAnswerCheckInstruction(dynamic)
    expect(appended.startsWith(dynamic)).toBe(true)
    expect(appended.endsWith(GUEST_ANSWER_CHECK_INSTRUCTION)).toBe(true)
    expect(GUEST_ANSWER_CHECK_INSTRUCTION).not.toMatch(/—/u)
  })
})

describe('splitGuestAnswerCheck', () => {
  it('returns only the answer and summarizes the decisions without quotes', () => {
    const split = splitGuestAnswerCheck(`  ${reply}  `)
    expect(split).toMatchObject({ answer, checkStatus: 'PRESENT', checkJson: 'VALID' })
    const summary = summarizeGuestAnswerCheck(split)
    expect(summary).toMatchObject({ decisionCount: 1, dispositions: ['NO'] })
    expect(JSON.stringify(summary)).not.toContain('Ticket sales')
    expect(summary.checkSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('delivers a reply that skipped the check unchanged and records the miss', () => {
    expect(splitGuestAnswerCheck(answer)).toMatchObject({
      answer,
      checkStatus: 'MISSING',
      checkJson: 'ABSENT',
    })
  })

  it('keeps an answer whose check JSON is malformed, recording it as invalid', () => {
    const split = splitGuestAnswerCheck(
      `${GUEST_ANSWER_CHECK_OPEN}{"decisions":[${GUEST_ANSWER_CHECK_CLOSE}${answer}`,
    )
    expect(split).toMatchObject({ answer, checkJson: 'INVALID', decisions: null })
  })

  it.each([
    [`${GUEST_ANSWER_CHECK_OPEN}${check}`, 'UNTERMINATED_CHECK'],
    [`${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}   `, 'EMPTY_ANSWER'],
    [`${reply} ${GUEST_ANSWER_CHECK_OPEN}{}${GUEST_ANSWER_CHECK_CLOSE}`, 'REPEATED_CHECK'],
    [`${answer} ${GUEST_ANSWER_CHECK_CLOSE}`, 'REPEATED_CHECK'],
    ['   ', 'EMPTY_ANSWER'],
  ])('fails closed when no safe guest answer exists (%#)', (raw, code) => {
    expect(() => splitGuestAnswerCheck(raw)).toThrow(GuestAnswerCheckFormatError)
    try {
      splitGuestAnswerCheck(raw)
    } catch (error) {
      expect((error as GuestAnswerCheckFormatError).code).toBe(code)
    }
  })
})

describe('createGuestAnswerCheckStreamGate', () => {
  it('never exposes check text for any two-chunk split and streams the exact answer', async () => {
    for (let index = 1; index < reply.length; index += 1) {
      const visible = await streamed([reply.slice(0, index), reply.slice(index)])
      expect(visible).toBe(answer)
    }
  })

  it('handles one-character deltas', async () => {
    const visible = await streamed([...reply])
    expect(visible).toBe(answer)
  })

  it('streams nothing while the check is still open (truncated reply)', async () => {
    expect(await streamed([GUEST_ANSWER_CHECK_OPEN, check.slice(0, 40)])).toBe('')
  })

  it('passes a reply without a check through from the first decisive character', async () => {
    const out: string[] = []
    const push = createGuestAnswerCheckStreamGate((delta) => {
      out.push(delta)
    })
    await push('\n<')
    expect(out).toEqual([])
    await push('p')
    expect(out.join('')).toBe('\n<p')
    await push(' rest')
    expect(out.join('')).toBe('\n<p rest')
  })

  it('agrees with the final split on every split point', async () => {
    for (let index = 1; index < reply.length; index += 7) {
      const visible = await streamed([reply.slice(0, index), reply.slice(index)])
      expect(visible).toBe(splitGuestAnswerCheck(reply).answer)
    }
  })
})
