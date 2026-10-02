import { describe, expect, it, vi } from 'vitest'

vi.mock('../client', () => ({ db: {} }))
vi.mock('./audit', () => ({ writeAuditLogStrict: vi.fn(async () => undefined) }))

import {
  boundedInboundPreview,
  candidateMessageIds,
  CLIENT_INBOUND_MAX_TEXT_BYTES,
  ClientInboundReplyError,
  hashInboundSender,
  linkInboundClientReply,
  normalizeInboundSenderAddress,
  type ClientInboundEmailInput,
} from './client-inbound-replies'
import { mintClientNotificationRfcMessageId } from './client-notification-intents'

const base: ClientInboundEmailInput = {
  provider: 'FAKE',
  mailboxId: 'mailbox-1',
  providerMessageId: 'pm-1',
  providerThreadId: null,
  rfcMessageId: '<m1@example.test>',
  inReplyTo: null,
  references: [],
  fromAddress: 'person@example.test',
  bodyText: 'hello',
  htmlBytes: 0,
  bodyTruncated: false,
  receivedAt: new Date('2026-10-02T12:00:00Z'),
}

describe('inbound reply helpers', () => {
  it('keeps only well-formed message ids, deduplicated, with In-Reply-To first', () => {
    expect(
      candidateMessageIds({
        inReplyTo: ' <a@x.test> ',
        references: ['<b@x.test>', '<a@x.test>', 'not an id', '<c d@x.test>', '<>'],
      }),
    ).toEqual(['<a@x.test>', '<b@x.test>'])
  })

  it('bounds the reference list to the newest ancestors', () => {
    const references = Array.from({ length: 200 }, (_, index) => `<r${index}@x.test>`)
    const ids = candidateMessageIds({ inReplyTo: null, references })
    expect(ids.length).toBeLessThanOrEqual(51)
    expect(ids.at(-1)).toBe('<r199@x.test>')
  })

  it('normalises sender addresses and never hashes display text as an address', () => {
    expect(normalizeInboundSenderAddress(' Person@Example.TEST ')).toBe('person@example.test')
    expect(normalizeInboundSenderAddress('Person <person@example.test>')).toBeNull()
    expect(hashInboundSender('A@x.test')).toBe(hashInboundSender('a@X.test'))
  })

  it('previews only new text: drops quoted history and control characters, and bounds length', () => {
    const preview = boundedInboundPreview(
      'Yes\u0000 it is\u202e fine.\n> old quote\nOn Mon, 1 Jan 2026 someone wrote:\nolder'.concat(
        'x'.repeat(2000),
      ),
    )
    expect(preview).toBe('Yes it is fine.')
    expect(boundedInboundPreview('y'.repeat(5000))).toHaveLength(500)
  })

  it('mints unguessable anchors only for a valid sending domain', () => {
    const first = mintClientNotificationRfcMessageId('mail.example.test')!
    expect(first).toMatch(/^<ci\.[0-9a-f]{48}@mail\.example\.test>$/u)
    expect(mintClientNotificationRfcMessageId('mail.example.test')).not.toBe(first)
    expect(mintClientNotificationRfcMessageId(undefined)).toBeNull()
    expect(mintClientNotificationRfcMessageId('bad domain>')).toBeNull()
  })
})

describe('linkInboundClientReply input boundary', () => {
  const quarantineCreate = vi.fn(async () => ({ id: 'q1' }))
  const client = { clientInboundQuarantine: { create: quarantineCreate } } as never

  it('rejects malformed provider identifiers outright', async () => {
    await expect(
      linkInboundClientReply({ ...base, providerMessageId: 'has space' }, client),
    ).rejects.toBeInstanceOf(ClientInboundReplyError)
    await expect(linkInboundClientReply({ ...base, provider: 'gmail' }, client)).rejects.toThrow()
    expect(quarantineCreate).not.toHaveBeenCalled()
  })

  it('quarantines oversized or truncated or sender-less messages before any lookup', async () => {
    for (const [input, reason] of [
      [{ bodyText: 'x'.repeat(CLIENT_INBOUND_MAX_TEXT_BYTES + 1) }, 'OVERSIZED_MESSAGE'],
      [{ htmlBytes: 200_001 }, 'OVERSIZED_MESSAGE'],
      [{ bodyTruncated: true }, 'OVERSIZED_MESSAGE'],
      [{ fromAddress: 'not an address' }, 'INVALID_MESSAGE'],
    ] as const) {
      quarantineCreate.mockClear()
      const result = await linkInboundClientReply({ ...base, ...input }, client)
      expect(result).toMatchObject({ state: 'QUARANTINED', reason })
      const data = (
        quarantineCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }]
      )[0].data
      expect(Object.keys(data)).not.toContain('bodyText')
      expect(JSON.stringify(data)).not.toContain('person@example.test')
    }
  })
})
