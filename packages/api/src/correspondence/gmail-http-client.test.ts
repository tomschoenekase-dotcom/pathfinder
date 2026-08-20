import { describe, expect, it, vi } from 'vitest'

import { GmailApiError } from './gmail'
import { createGmailApiClient } from './gmail-http-client'

function json(value: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function message(id: string) {
  return {
    id,
    threadId: 'thread-1',
    internalDate: '1710000000000',
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'Message-ID', value: `<${id}@example.test>` },
        { name: 'From', value: 'person@example.test' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          filename: '',
          body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
        },
      ],
      body: { size: 0 },
    },
  }
}

describe('createGmailApiClient', () => {
  it('sends one normalized message with bearer authorization', async () => {
    const request = vi.fn().mockResolvedValue(json({ id: 'm1', threadId: 't1' }))
    const client = createGmailApiClient({ fetch: request, apiBaseUrl: 'https://gmail.test/v1' })

    await expect(
      client.sendMessage({
        accessToken: 'short-lived-token',
        mailboxAddress: 'outreach@torchiko.com',
        rawBase64Url: 'frozen-message',
      }),
    ).resolves.toEqual({ id: 'm1', threadId: 't1' })
    expect(request).toHaveBeenCalledWith(
      'https://gmail.test/v1/users/outreach%40torchiko.com/messages/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer short-lived-token' }),
        body: JSON.stringify({ raw: 'frozen-message' }),
      }),
    )
  })

  it('classifies a transport loss during send as possibly accepted', async () => {
    const client = createGmailApiClient({
      fetch: vi.fn().mockRejectedValue(new Error('connection reset')),
    })
    await expect(
      client.sendMessage({
        accessToken: 'token',
        mailboxAddress: 'outreach@torchiko.com',
        rawBase64Url: 'frozen-message',
      }),
    ).rejects.toMatchObject({
      name: 'GmailApiError',
      kind: 'TRANSIENT',
      acceptance: 'MAY_HAVE_ACCEPTED',
    } satisfies Partial<GmailApiError>)
  })

  it('hydrates history additions before returning a durable cursor', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          historyId: '102',
          history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
        }),
      )
      .mockResolvedValueOnce(json(message('m1')))
    const client = createGmailApiClient({ fetch: request })

    const page = await client.listHistory({
      accessToken: 'token',
      mailboxAddress: 'outreach@torchiko.com',
      startHistoryId: '100',
      pageSize: 100,
    })
    expect(page.historyId).toBe('102')
    expect(page.messages[0]).toMatchObject({ id: 'm1', textBody: 'hello' })
  })

  it('classifies a missing history cursor separately from a missing message', async () => {
    const client = createGmailApiClient({ fetch: vi.fn().mockResolvedValue(json({}, 404)) })
    await expect(
      client.listHistory({
        accessToken: 'token',
        mailboxAddress: 'outreach@torchiko.com',
        startHistoryId: 'expired',
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ kind: 'HISTORY_CURSOR_EXPIRED' })
  })
})
