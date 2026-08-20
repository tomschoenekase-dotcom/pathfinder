import { GmailApiError, type GmailApiClient, type GmailApiMessage } from './gmail'

type Fetch = typeof fetch
type Json = Record<string, unknown>

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
  input: { fetch?: Fetch; apiBaseUrl?: string } = {},
): GmailApiClient {
  const transport = input.fetch ?? fetch
  const base = input.apiBaseUrl ?? 'https://gmail.googleapis.com/gmail/v1'

  async function call(args: {
    accessToken: string
    mailboxAddress: string
    path: string
    method?: 'GET' | 'POST'
    body?: unknown
    mayAccept?: boolean
    history?: boolean
  }): Promise<Json> {
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
          signal: AbortSignal.timeout(30_000),
        },
      )
    } catch (error) {
      throw new GmailApiError(
        'TRANSIENT',
        error instanceof Error ? error.message : 'Gmail transport failed',
        args.mayAccept ? 'MAY_HAVE_ACCEPTED' : 'NOT_ACCEPTED',
      )
    }
    if (!response.ok) {
      throw new GmailApiError(
        errorKind(response.status, args.history === true),
        `Gmail request failed with HTTP ${response.status}`,
        'NOT_ACCEPTED',
        retryAfter(response),
      )
    }
    return response.status === 204 ? {} : object(await response.json())
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
