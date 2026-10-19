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
const chunked = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  )

function formatCode(raw: string) {
  try {
    splitGuestAnswerCheck(raw)
    return 'OK'
  } catch (error) {
    return (error as GuestAnswerCheckFormatError).code
  }
}

describe('guest answer check mode', () => {
  it('is off unless explicitly selected, including for unknown values', () => {
    expect(guestAnswerCheckMode({})).toBe('off')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: 'yes' })).toBe('off')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: ' Economy ' })).toBe('economy')
    expect(guestAnswerCheckMode({ GUEST_CHAT_ANSWER_CHECK: 'all' })).toBe('all')
  })

  it('selects only economy routes with room for the check in economy mode', () => {
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-luna')).toBe(true)
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-luna', null)).toBe(true)
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-luna', 512)).toBe(false)
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-sol')).toBe(false)
    // Economy routes capped at 512 output tokens would truncate the answer after the check.
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat')).toBe(false)
    expect(isGuestAnswerCheckEnabled('economy', 'guest-chat-openai')).toBe(false)
    expect(isGuestAnswerCheckEnabled('all', 'guest-chat-openai')).toBe(false)
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
    expect(GUEST_ANSWER_CHECK_INSTRUCTION).not.toMatch(/[‒-―]/u)
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
    expect(splitGuestAnswerCheck('{curly} plans are fine.').checkStatus).toBe('MISSING')
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
    [`${answer} ${GUEST_ANSWER_CHECK_CLOSE}`, 'MALFORMED_CHECK'],
    ['   ', 'EMPTY_ANSWER'],
    [
      `\`\`\`json\n${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}\n${answer}`,
      'MALFORMED_CHECK',
    ],
    [
      `Sure! ${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE} ${answer}`,
      'MALFORMED_CHECK',
    ],
    [`<answer_check >${check}</answer_check>\n${answer}`, 'MALFORMED_CHECK'],
    [`<answer-check>${check}</answer-check>\n${answer}`, 'MALFORMED_CHECK'],
    [`<ANSWER_CHECK>${check}</ANSWER_CHECK>\n${answer}`, 'MALFORMED_CHECK'],
    [`${check}\n${answer}`, 'MALFORMED_CHECK'],
    [`\`\`\`json\n${check}\n\`\`\`\n${answer}`, 'MALFORMED_CHECK'],
  ])('fails closed when no safe guest answer exists (%#)', (raw, code) => {
    expect(formatCode(raw)).toBe(code)
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
    expect(await streamed([...reply])).toBe(answer)
  })

  it('streams nothing while the check is still open (truncated reply)', async () => {
    expect(await streamed([GUEST_ANSWER_CHECK_OPEN, check.slice(0, 40)])).toBe('')
  })

  it('passes a plain reply through once it cannot be a check', async () => {
    const out: string[] = []
    const push = createGuestAnswerCheckStreamGate((delta) => {
      out.push(delta)
    })
    await push('\nThe ')
    expect(out.join('')).toBe('The ')
    await push('museum opens at 10.')
    expect(out.join('')).toBe('The museum opens at 10.')
  })

  it.each([
    `\`\`\`json\n${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}\n${answer}`,
    `Sure! ${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE} ${answer}`,
    `${answer} ${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}`,
    `<answer_check >${check}</answer_check>\n${answer}`,
    `<answer-check>${check}</answer-check>\n${answer}`,
    `<ANSWER_CHECK>${check}</ANSWER_CHECK>\n${answer}`,
    `${check}\n${answer}`,
    `${reply} ${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}`,
  ])('never streams check text in a wrong form, at any chunk size (%#)', async (raw) => {
    for (const size of [1, 3, 4, 7, 16, raw.length]) {
      const visible = await streamed(chunked(raw, size))
      expect(visible).not.toMatch(/decisions|evidenceQuotes|answer.?check/iu)
      expect(formatCode(raw)).not.toBe('OK')
    }
  })

  it('agrees with the final split on every split point', async () => {
    for (let index = 1; index < reply.length; index += 7) {
      const visible = await streamed([reply.slice(0, index), reply.slice(index)])
      expect(visible).toBe(splitGuestAnswerCheck(reply).answer)
    }
  })
})
