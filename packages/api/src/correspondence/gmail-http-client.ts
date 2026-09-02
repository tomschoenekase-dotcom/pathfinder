import { GmailApiError, type GmailApiClient, type GmailApiMessage } from './gmail'

type Fetch = typeof fetch
type Json = Record<string, unknown>
const GMAIL_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
const GMAIL_REQUEST_TIMEOUT_MS = 30_000

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > GMAIL_RESPONSE_MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('response-too-large')
  }
  if (!response.body) throw new Error('malformed-response')

  const reader = response.body.getReader()
  const cancelOnAbort = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', cancelOnAbort, { once: true })
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let reading = true
  try {
    while (reading) {
      const { done, value } = await reader.read()
      if (done) {
        reading = false
        continue
      }
      totalBytes += value.byteLength
      if (totalBytes > GMAIL_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new Error('response-too-large')
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function boundedTimeout(value: number | undefined) {
  const timeoutMs = value ?? GMAIL_REQUEST_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Gmail request timeout must be an integer from 1 to 60000 milliseconds')
  }
  return timeoutMs
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GmailApiError('PERMANENT', 'Gmail returned a malformed response')
  }
  return value as Json
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new GmailApiError('PERMANENT', `Gmail response omitted ${label}`)
  }
  return value
}

function decode(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    return Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }
}

function allParts(payload: Json): Json[] {
  const children = Array.isArray(payload.parts) ? payload.parts.map(object) : []
  return [payload, ...children.flatMap(allParts)]
}

function normalizeMessage(value: unknown): GmailApiMessage {
  const message = object(value)
  const payload = object(message.payload)
  const parts = allParts(payload)
  const headers: Record<string, string> = {}
  for (const candidate of Array.isArray(payload.headers) ? payload.headers : []) {
    const header = object(candidate)
    if (typeof header.name === 'string' && typeof header.value === 'string') {
      headers[header.name.toLowerCase()] = header.value
    }
  }
  const bodyFor = (mimeType: string) => {
    const part = parts.find((candidate) => candidate.mimeType === mimeType)
    return part ? decode(object(part.body).data) : null
  }
  const attachments = parts.flatMap((part) => {
    const body = object(part.body)
    if (typeof body.attachmentId !== 'string' || typeof part.filename !== 'string') return []
    return [
      {
        id: body.attachmentId,
        filename: part.filename,
        mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream',
        sizeBytes: typeof body.size === 'number' ? body.size : 0,
      },
    ]
  })
  return {
    id: required(message.id, 'message ID'),
    threadId: required(message.threadId, 'thread ID'),
    internalDateMs: Number(required(message.internalDate, 'internal date')),
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.filter((item): item is string => typeof item === 'string')
      : [],
    headers,
    textBody: bodyFor('text/plain'),
    htmlBody: bodyFor('text/html'),
    attachments,
  }
}

function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get('retry-after'))
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : null
}

function errorKind(status: number, history: boolean) {
  if (status === 401 || status === 403) return 'AUTHENTICATION' as const
  if (status === 404) return history ? ('HISTORY_CURSOR_EXPIRED' as const) : ('NOT_FOUND' as const)
  if (status === 429) return 'RATE_LIMIT' as const
  if (status === 408 || status >= 500) return 'TRANSIENT' as const
  return 'PERMANENT' as const
}

export function createGmailApiClient(
  input: { fetch?: Fetch; apiBaseUrl?: string; requestTimeoutMs?: number } = {},
): GmailApiClient {
  const transport = input.fetch ?? fetch
  const base = input.apiBaseUrl ?? 'https://gmail.googleapis.com/gmail/v1'
  const timeoutMs = boundedTimeout(input.requestTimeoutMs)

  async function call(args: {
    accessToken: string
    mailboxAddress: string
    path: string
    method?: 'GET' | 'POST'
    body?: unknown
    mayAccept?: boolean
    history?: boolean
  }): Promise<Json> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await transport(
          `${base}/users/${encodeURIComponent(args.mailboxAddress)}/${args.path}`,
          {
            method: args.method ?? 'GET',
            headers: {
              authorization: `Bearer ${args.accessToken}`,
              accept: 'application/json',
              ...(args.body ? { 'content-type': 'application/json' } : {}),
            },
            ...(args.body ? { body: JSON.stringify(args.body) } : {}),
            signal: controller.signal,
          },
        )
      } catch {
        throw new GmailApiError(
          'TRANSIENT',
          controller.signal.aborted ? 'Gmail request timed out' : 'Gmail transport failed',
          args.mayAccept ? 'MAY_HAVE_ACCEPTED' : 'NOT_ACCEPTED',
        )
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw new GmailApiError(
          errorKind(response.status, args.history === true),
          `Gmail request failed with HTTP ${response.status}`,
          'NOT_ACCEPTED',
          retryAfter(response),
        )
      }
      if (response.status === 204) return {}
      try {
        return object(await readBoundedJson(response, controller.signal))
      } catch (error) {
        if (error instanceof GmailApiError) throw error
        throw new GmailApiError(
          controller.signal.aborted ? 'TRANSIENT' : 'PERMANENT',
          controller.signal.aborted
            ? 'Gmail request timed out'
            : 'Gmail returned a malformed response',
          args.mayAccept ? 'MAY_HAVE_ACCEPTED' : 'NOT_ACCEPTED',
        )
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  const getMessage = async (accessToken: string, mailboxAddress: string, messageId: string) =>
    normalizeMessage(
      await call({
        accessToken,
        mailboxAddress,
        path: `messages/${encodeURIComponent(messageId)}?format=full`,
      }),
    )
  const hydrate = async (accessToken: string, mailboxAddress: string, ids: readonly string[]) =>
    Promise.all(
      [...new Set(ids)].slice(0, 100).map((id) => getMessage(accessToken, mailboxAddress, id)),
    )

  return {
    async sendMessage(args) {
      const response = await call({
        ...args,
        path: 'messages/send',
        method: 'POST',
        body: { raw: args.rawBase64Url, ...(args.threadId ? { threadId: args.threadId } : {}) },
        mayAccept: true,
      })
      return {
        id: required(response.id, 'message ID'),
        threadId: required(response.threadId, 'thread ID'),
      }
    },
    getMessage: (args) => getMessage(args.accessToken, args.mailboxAddress, args.messageId),
    async getThread(args) {
      const response = await call({
        ...args,
        path: `threads/${encodeURIComponent(args.threadId)}?format=full`,
      })
      return (Array.isArray(response.messages) ? response.messages : []).map(normalizeMessage)
    },
    async listHistory(args) {
      const query = new URLSearchParams({
        startHistoryId: args.startHistoryId,
        maxResults: String(Math.min(args.pageSize, 100)),
        historyTypes: 'messageAdded',
        ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      })
      const response = await call({ ...args, path: `history?${query}`, history: true })
      const ids = (Array.isArray(response.history) ? response.history : []).flatMap((entry) => {
        const row = object(entry)
        return (Array.isArray(row.messagesAdded) ? row.messagesAdded : []).flatMap((added) => {
          const message = object(object(added).message)
          return typeof message.id === 'string' ? [message.id] : []
        })
      })
      return {
        messages: await hydrate(args.accessToken, args.mailboxAddress, ids),
        historyId: required(response.historyId, 'history ID'),
        ...(typeof response.nextPageToken === 'string'
          ? { nextPageToken: response.nextPageToken }
          : {}),
      }
    },
    async listMessages(args) {
      const query = new URLSearchParams({
        maxResults: String(Math.min(args.pageSize, 100)),
        q: `after:${Math.floor(args.after.getTime() / 1_000)}`,
        ...(args.pageToken ? { pageToken: args.pageToken } : {}),
      })
      const response = await call({ ...args, path: `messages?${query}` })
      const ids = (Array.isArray(response.messages) ? response.messages : []).flatMap((item) => {
        const message = object(item)
        return typeof message.id === 'string' ? [message.id] : []
      })
      const profile = await call({ ...args, path: 'profile' })
      return {
        messages: await hydrate(args.accessToken, args.mailboxAddress, ids),
        historyId: required(profile.historyId, 'history ID'),
        ...(typeof response.nextPageToken === 'string'
          ? { nextPageToken: response.nextPageToken }
          : {}),
      }
    },
    async watch(args) {
      const response = await call({
        ...args,
        path: 'watch',
        method: 'POST',
        body: {
          topicName: args.topicName,
          labelFilterBehavior: 'INCLUDE',
          labelIds: ['INBOX', 'SENT'],
        },
      })
      return {
        historyId: required(response.historyId, 'history ID'),
        expirationMs: Number(required(response.expiration, 'watch expiration')),
      }
    },
    async stopWatch(args) {
      await call({ ...args, path: 'stop', method: 'POST' })
    },
    async findByRfcMessageId(args) {
      const query = new URLSearchParams({ q: `rfc822msgid:${args.rfcMessageId}`, maxResults: '10' })
      const response = await call({ ...args, path: `messages?${query}` })
      const ids = (Array.isArray(response.messages) ? response.messages : []).flatMap((item) => {
        const message = object(item)
        return typeof message.id === 'string' ? [message.id] : []
      })
      return hydrate(args.accessToken, args.mailboxAddress, ids)
    },
    async getProfile(args) {
      const response = await call({ ...args, path: 'profile' })
      return {
        emailAddress: required(response.emailAddress, 'email address'),
        historyId: required(response.historyId, 'history ID'),
      }
    },
  }
}
