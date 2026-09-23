import { describe, expect, it, vi } from 'vitest'

import { GmailApiError } from './gmail'
import { createGmailApiClient } from './gmail-http-client'
import { createGmailCorrespondenceProvider } from './gmail'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'
import { createHash } from 'node:crypto'
import type { ProviderMailboxRef } from './types'

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

const recoveryMailbox: ProviderMailboxRef = {
  provider: 'GMAIL',
  providerAccountId: 'account-1',
  mailboxId: 'mailbox-1',
  mailboxAddress: 'outreach@torchiko.com',
  credentialRef: 'credential-ref-1',
}

describe('createGmailApiClient', () => {
  it('fetches bounded QR bytes only for an explicit SENT recovery lookup', async () => {
    const bytes = Buffer.from('<svg/>')
    const asset: VenueLaunchAsset = {
      schema: 'torchiko.venue-launch-asset/1',
      tenantId: 'tenant',
      venueId: 'venue',
      release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
      publicUrl: 'https://example.com/chat?source=qr',
      filename: 'venue-qr.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentBase64: bytes.toString('base64'),
    }
    const full = {
      ...message('m1'),
      labelIds: ['SENT'],
      payload: {
        headers: [
          { name: 'Message-ID', value: '<send@example.test>' },
          { name: 'From', value: recoveryMailbox.mailboxAddress },
          { name: 'To', value: 'person@example.org' },
          { name: 'Subject', value: 'Subject' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            filename: '',
            body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
          },
          {
            mimeType: asset.mimeType,
            filename: asset.filename,
            body: { attachmentId: 'a1', size: bytes.length },
          },
        ],
        body: { size: 0 },
      },
    }
    const request = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }] })
      if (url.endsWith('/messages/m1?format=full')) return json(full)
      if (url.endsWith('/messages/m1/attachments/a1'))
        return json({ data: bytes.toString('base64url'), size: bytes.length })
      throw new Error(`unexpected request ${url}`)
    })
    const client = createGmailApiClient({ fetch: request, apiBaseUrl: 'https://gmail.test/v1' })
    await client.getMessage({
      accessToken: 'token',
      mailboxAddress: recoveryMailbox.mailboxAddress,
      messageId: 'm1',
    })
    expect(request).toHaveBeenCalledTimes(1)
    const found = await client.findByRfcMessageId({
      accessToken: 'token',
      mailboxAddress: recoveryMailbox.mailboxAddress,
      rfcMessageId: '<send@example.test>',
      expectedAttachments: [asset],
    })
    expect(found[0]?.attachments?.[0]?.contentBase64Url).toBe(bytes.toString('base64url'))
    expect(request).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['PNG', 'image/png', 'venue-qr.png', Buffer.from('png fixture')],
    ['PDF', 'application/pdf', 'venue-qr.pdf', Buffer.from('%PDF-1.4 fixture')],
  ] as const)(
    'recognizes the frozen %s attachment during SENT recovery',
    async (format, mimeType, filename, bytes) => {
      const asset: VenueLaunchAsset = {
        schema: 'torchiko.venue-launch-asset/2',
        tenantId: 'tenant',
        venueId: 'venue',
        release: { kind: 'NATIVE', id: 'release', revisionSha256: 'a'.repeat(64) },
        publicUrl: 'https://example.com/chat?source=qr',
        format,
        generatorVersion: 'qr-print-v1',
        filename,
        mimeType,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      }
      const full = {
        ...message('m1'),
        labelIds: ['SENT'],
        payload: {
          headers: [
            { name: 'Message-ID', value: '<send@example.test>' },
            { name: 'From', value: recoveryMailbox.mailboxAddress },
            { name: 'To', value: 'person@example.org' },
            { name: 'Subject', value: 'Subject' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              filename: '',
              body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
            },
            { mimeType, filename, body: { attachmentId: 'a1', size: bytes.length } },
          ],
          body: { size: 0 },
        },
      }
      const request = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }] })
        if (url.endsWith('/messages/m1?format=full')) return json(full)
        if (url.endsWith('/messages/m1/attachments/a1'))
          return json({ data: bytes.toString('base64url'), size: bytes.length })
        throw new Error(`unexpected request ${url}`)
      })
      const client = createGmailApiClient({ fetch: request, apiBaseUrl: 'https://gmail.test/v1' })
      const found = await client.findByRfcMessageId({
        accessToken: 'token',
        mailboxAddress: recoveryMailbox.mailboxAddress,
        rfcMessageId: '<send@example.test>',
        expectedAttachments: [asset],
      })
      expect(found).toHaveLength(1)
      expect(found[0]).not.toHaveProperty('hasUnexpectedMimeParts')
      expect(found[0]?.attachments?.[0]?.contentBase64Url).toBe(bytes.toString('base64url'))
    },
  )

  it.each([
    'duplicate critical header',
    'inline non-text MIME part',
    'multiple text/plain MIME parts',
  ] as const)('holds recovery for %s', async (kind) => {
    const base = message('m1')
    const full = {
      ...base,
      labelIds: ['SENT'],
      payload: {
        ...base.payload,
        headers: [
          ...base.payload.headers,
          { name: 'From', value: recoveryMailbox.mailboxAddress },
          { name: 'To', value: 'person@example.org' },
          { name: 'Subject', value: 'Subject' },
          ...(kind === 'duplicate critical header'
            ? [{ name: 'To', value: 'other@example.org' }]
            : []),
        ],
        parts: [
          ...base.payload.parts,
          ...(kind === 'inline non-text MIME part'
            ? [{ mimeType: 'image/png', filename: '', body: { data: 'aW1hZ2U=' } }]
            : kind === 'multiple text/plain MIME parts'
              ? [{ mimeType: 'text/plain', filename: '', body: { data: 'dGFtcGVyZWQ=' } }]
              : []),
        ],
      },
    }
    const request = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1' }] })
      if (url.endsWith('/messages/m1?format=full')) return json(full)
      throw new Error(`unexpected request ${url}`)
    })
    const client = createGmailApiClient({ fetch: request, apiBaseUrl: 'https://gmail.test/v1' })
    const provider = createGmailCorrespondenceProvider({
      client,
      credentials: {
        lease: vi.fn(async () => ({
          withAccessToken: async <T>(callback: (token: string) => Promise<T>) => callback('token'),
        })),
      },
    })
    await expect(
      provider.lookupSendOperation({
        mailbox: recoveryMailbox,
        operationId: 'operation-1',
        rfcMessageId: '<send@example.test>',
        expected: {
          senderEmail: recoveryMailbox.mailboxAddress,
          recipientEmail: 'person@example.org',
          subject: 'Subject',
          textBody: 'hello',
        },
      }),
    ).resolves.toEqual({ state: 'NOT_FOUND' })
  })

  it('does not classify repeated Received headers as critical duplication', async () => {
    const base = message('m1')
    const request = vi.fn().mockResolvedValue(
      json({
        ...base,
        payload: {
          ...base.payload,
          headers: [
            ...base.payload.headers,
            { name: 'Received', value: 'by mx-one' },
            { name: 'Received', value: 'by mx-two' },
          ],
        },
      }),
    )
    const client = createGmailApiClient({ fetch: request, apiBaseUrl: 'https://gmail.test/v1' })
    const normalized = await client.getMessage({
      accessToken: 'token',
      mailboxAddress: recoveryMailbox.mailboxAddress,
      messageId: 'm1',
    })
    expect(normalized).not.toHaveProperty('duplicateCriticalHeaders')
  })

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

  it('classifies an incomplete acceptance identity as possibly accepted', async () => {
    const client = createGmailApiClient({ fetch: vi.fn().mockResolvedValue(json({ id: 'm1' })) })
    await expect(
      client.sendMessage({
        accessToken: 'token',
        mailboxAddress: 'outreach@torchiko.com',
        rawBase64Url: 'frozen-message',
      }),
    ).rejects.toMatchObject({
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
    let canceled = false
    const body = new ReadableStream({
      cancel() {
        canceled = true
      },
    })
    const client = createGmailApiClient({
      fetch: vi.fn().mockResolvedValue(new Response(body, { status: 404 })),
    })
    await expect(
      client.listHistory({
        accessToken: 'token',
        mailboxAddress: 'outreach@torchiko.com',
        startHistoryId: 'expired',
        pageSize: 100,
      }),
    ).rejects.toMatchObject({ kind: 'HISTORY_CURSOR_EXPIRED' })
    expect(canceled).toBe(true)
  })

  it('rejects and cancels a response whose declared length exceeds the safety limit', async () => {
    let canceled = false
    const body = new ReadableStream({
      cancel() {
        canceled = true
      },
    })
    const client = createGmailApiClient({
      fetch: vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
        }),
      ),
    })

    await expect(
      client.getProfile({ accessToken: 'token', mailboxAddress: 'outreach@torchiko.com' }),
    ).rejects.toMatchObject({ kind: 'PERMANENT', message: 'Gmail returned a malformed response' })
    expect(canceled).toBe(true)
  })

  it('bounds and cancels a stalled response body', async () => {
    let canceled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel() {
        canceled = true
      },
    })
    const client = createGmailApiClient({
      fetch: vi.fn().mockResolvedValue(new Response(body)),
      requestTimeoutMs: 10,
    })

    await expect(
      client.getProfile({ accessToken: 'token', mailboxAddress: 'outreach@torchiko.com' }),
    ).rejects.toMatchObject({ kind: 'TRANSIENT', message: 'Gmail request timed out' })
    expect(canceled).toBe(true)
  })
})
