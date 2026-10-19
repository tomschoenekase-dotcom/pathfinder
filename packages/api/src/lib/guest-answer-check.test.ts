import { describe, expect, it, vi } from 'vitest'

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

  it('rejects missing checks and malformed schemas instead of accepting plain-model output', () => {
    expect(formatCode(answer)).toBe('MISSING_CHECK')
    for (const body of [
      '{"decisions":[',
      '{"decisions":[]}',
      JSON.stringify({ decisions: [{ disposition: 'PRIVATE_TEXT' }] }),
      check.replace('"NO"', '"PRIVATE_TEXT"'),
      check.replace('"conditions":[]', '"conditions":"private"'),
    ]) {
      expect(() =>
        splitGuestAnswerCheck(
          `${GUEST_ANSWER_CHECK_OPEN}${body}${GUEST_ANSWER_CHECK_CLOSE}${answer}`,
        ),
      ).toThrow(GuestAnswerCheckFormatError)
    }
  })

  it('treats tag bytes and escaped quotes within JSON strings as private data', () => {
    const body = JSON.parse(check)
    body.decisions[0].evidenceQuotes = [
      '</answer_check>',
      'a "quote" and \\ slash',
      '[[ENGAGEMENT_ASKED]]',
    ]
    expect(
      splitGuestAnswerCheck(
        `${GUEST_ANSWER_CHECK_OPEN}${JSON.stringify(body)}${GUEST_ANSWER_CHECK_CLOSE}${answer}`,
      ).answer,
    ).toBe(answer)
  })

  it('supports normal links, action markers and engagement while excluding other bracket forms', () => {
    const plain =
      'You can [[link:book-now|book now]]. [Map](https://example.org/map) [[button:book-now]] [[ENGAGEMENT_ASKED]]'
    expect(
      splitGuestAnswerCheck(`${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}${plain}`)
        .answer,
    ).toBe(plain)
    for (const unsupported of [
      '["private quote"]',
      '[private quote]',
      '<tag>text</tag>',
      '~~~text~~~',
      '`text`',
      '{text}',
    ]) {
      expect(formatCode(`${reply} ${unsupported}`)).toBe('UNSUPPORTED_ANSWER_FORMAT')
    }
  })
})

const malformedReplies = [
  answer,
  `Sure!\n${check}\n${answer}`,
  `Here is the check:\n\`\`\`json\n${check}\n\`\`\`\n${answer}`,
  `~~~json\n${check}\n~~~\n${answer}`,
  `[${check}]\n${answer}`,
  `<${' '.repeat(35)}answer_check>${check}</answer_check>${answer}`,
  `<answer_check >${check}</answer_check>\n${answer}`,
  `<answer-check>${check}</answer-check>\n${answer}`,
  `<ANSWER_CHECK>${check}</ANSWER_CHECK>\n${answer}`,
  `${GUEST_ANSWER_CHECK_OPEN}${check}`,
  `${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}   `,
  `${reply} ${GUEST_ANSWER_CHECK_OPEN}${check}${GUEST_ANSWER_CHECK_CLOSE}`,
  `${reply} ${check}`,
  `${reply} Sure! [${check}]`,
  `${reply} \`\`\`json\n${check}\n\`\`\``,
  `${reply} ~~~json\n${check}\n~~~`,
  `${reply} ["private quote"]`,
  '   ',
]

describe('createGuestAnswerCheckStreamGate', () => {
  it('withholds every two-chunk partition until complete validation, then releases the answer', async () => {
    for (let index = 1; index < reply.length; index += 1) {
      const out: string[] = []
      const gate = createGuestAnswerCheckStreamGate((delta) => {
        out.push(delta)
      })
      await gate(reply.slice(0, index))
      expect(out).toEqual([])
      await gate(reply.slice(index))
      expect(out).toEqual([])
      await gate.complete(reply)
      expect(out).toEqual([answer])
    }
  })

  it.each(malformedReplies)(
    'rejects malformed output without emitting any deltas (%#)',
    async (raw) => {
      for (const size of [1, 3, 4, 7, 16, raw.length]) {
        expect(await streamed(chunked(raw, size))).toBe('')
        const forward = vi.fn()
        const gate = createGuestAnswerCheckStreamGate(forward)
        for (const chunk of chunked(raw, size)) await gate(chunk)
        await expect(gate.complete(raw)).rejects.toBeInstanceOf(GuestAnswerCheckFormatError)
        expect(forward).not.toHaveBeenCalled()
        expect(formatCode(raw)).not.toBe('OK')
      }
    },
  )

  it('releases only the accepted final response even if deltas differ or an attempt fails', async () => {
    const out: string[] = []
    const gate = createGuestAnswerCheckStreamGate((delta) => {
      out.push(delta)
    })
    await gate('private failed attempt')
    await gate(reply)
    expect(out).toEqual([])
    await gate.complete(reply.replace(answer, 'Accepted final answer.'))
    expect(out).toEqual(['Accepted final answer.'])
  })
})
