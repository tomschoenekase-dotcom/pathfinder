import OpenAI from 'openai'
import { z } from 'zod'

const MAX_QUERY_CODE_POINTS = 500
const MAX_DOMAINS = 100
const MAX_REFERENCES = 12
const MAX_TITLE_CODE_POINTS = 500
const MAX_URL_LENGTH = 2048
const MAX_RESPONSE_TEXT_UTF8_BYTES = 40_000
const SECRET_URL_KEY =
  /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu

type ResponsesClient = {
  responses: {
    create(
      body: Record<string, unknown>,
      options: { signal: AbortSignal; timeout: number },
    ): Promise<unknown>
  }
}

export type GuestWebSearchReference = {
  title: string
  url: string
  cited: boolean
}

export type GuestWebSearchResult = {
  provider: 'openai'
  model: string
  responseId: string
  text: string
  references: GuestWebSearchReference[]
  usage: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    totalTokens: number
    webSearchToolCalls: number
  }
}

export class GuestWebSearchError extends Error {
  readonly observedUsage?: {
    model: string
    usage: GuestWebSearchResult['usage']
  }

  constructor(
    message: string,
    readonly code:
      | 'invalid-request'
      | 'provider-error'
      | 'invalid-provider-response'
      | 'incomplete-provider-response'
      | 'cancelled',
    options?: ErrorOptions & {
      observedUsage?: { model: string; usage: GuestWebSearchResult['usage'] }
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GuestWebSearchError'
    if (options?.observedUsage) this.observedUsage = options.observedUsage
  }
}

const integerUsage = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const citationSchema = z
  .object({
    type: z.literal('url_citation'),
    title: z.string(),
    url: z.string(),
  })
  .passthrough()
const sourceSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    url: z.string(),
  })
  .passthrough()
const responseSchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
    status: z.string(),
    output: z.array(z.unknown()),
    usage: z
      .object({
        input_tokens: integerUsage,
        input_tokens_details: z.object({ cached_tokens: integerUsage }).passthrough(),
        output_tokens: integerUsage,
        total_tokens: integerUsage,
      })
      .passthrough(),
  })
  .passthrough()

let sharedClient: ResponsesClient | null = null

function defaultClient(): ResponsesClient {
  if (!sharedClient) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')
    sharedClient = new OpenAI({ apiKey, maxRetries: 0 }) as unknown as ResponsesClient
  }
  return sharedClient
}

function boundedText(value: string, maximum: number): string {
  return [...value.normalize('NFC')].slice(0, maximum).join('').trim()
}

function normalizeQuery(query: string): string | null {
  const normalized = query.normalize('NFC').replace(/\s+/gu, ' ').trim()
  return [...normalized].length <= MAX_QUERY_CODE_POINTS ? normalized : null
}

function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/u, '')
  if (
    !domain ||
    domain.length > 253 ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes('@') ||
    domain.includes('?') ||
    domain.includes('#') ||
    /\.(?:internal|lan|local)$/u.test(domain)
  )
    return null
  try {
    const hostname = new URL(`https://${domain}`).hostname
    if (hostname !== domain || hostname === 'localhost' || hostname.endsWith('.localhost'))
      return null
    if (!hostname.includes('.') || /^\d+(?:\.\d+){3}$/u.test(hostname)) return null
    return hostname
  } catch {
    return null
  }
}

function hostnameAllowed(hostname: string, domains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '')
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`))
}

function safeReferenceUrl(value: string, domains: readonly string[]): string | null {
  if (value.length > MAX_URL_LENGTH) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !hostnameAllowed(url.hostname, domains)
    )
      return null
    const keys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
    if (keys.some((key) => SECRET_URL_KEY.test(key))) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function providerError(error: unknown, externallyAborted: boolean): GuestWebSearchError {
  if (externallyAborted)
    return new GuestWebSearchError('Guest web search was cancelled', 'cancelled', { cause: error })
  return new GuestWebSearchError('Guest web search provider request failed', 'provider-error', {
    cause: error,
  })
}

export async function searchGuestWeb(params: {
  query: string
  allowedDomains: readonly string[]
  model: string
  timeoutMs: number
  maxOutputTokens: number
  maxToolCalls: number
  maxResults: number
  signal?: AbortSignal
  client?: ResponsesClient
}): Promise<GuestWebSearchResult> {
  const query = normalizeQuery(params.query)
  const domains = [...new Set(params.allowedDomains.map(normalizeDomain))]
  if (
    !query ||
    !params.model.trim() ||
    !Number.isInteger(params.timeoutMs) ||
    params.timeoutMs < 1 ||
    !Number.isInteger(params.maxOutputTokens) ||
    params.maxOutputTokens < 1 ||
    !Number.isInteger(params.maxToolCalls) ||
    params.maxToolCalls !== 1 ||
    !Number.isInteger(params.maxResults) ||
    params.maxResults < 1 ||
    params.maxResults > MAX_REFERENCES ||
    domains.length < 1 ||
    domains.length > MAX_DOMAINS ||
    domains.some((domain) => domain === null)
  ) {
    throw new GuestWebSearchError(
      'Guest web search request is outside its bounds',
      'invalid-request',
    )
  }
  if (params.signal?.aborted)
    throw new GuestWebSearchError('Guest web search was cancelled', 'cancelled')

  const allowedDomains = domains as string[]
  const controller = new AbortController()
  const abort = () => controller.abort(params.signal?.reason)
  params.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Guest web search timed out')),
    params.timeoutMs,
  )

  let raw: unknown
  try {
    const providerRequest = (params.client ?? defaultClient()).responses.create(
      {
        model: params.model,
        input: query,
        instructions:
          'Answer only the bounded general-information query. Do not infer venue policies, operations, location, hours, prices, accessibility, or current venue status.',
        tools: [{ type: 'web_search', filters: { allowed_domains: allowedDomains } }],
        tool_choice: { type: 'web_search' },
        include: ['web_search_call.action.sources'],
        max_output_tokens: params.maxOutputTokens,
        max_tool_calls: params.maxToolCalls,
        parallel_tool_calls: false,
        store: false,
      },
      { signal: controller.signal, timeout: params.timeoutMs },
    )
    raw = await Promise.race([
      providerRequest,
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason ?? new Error('Guest web search aborted')),
          { once: true },
        )
      }),
    ])
  } catch (error) {
    throw providerError(error, params.signal?.aborted === true)
  } finally {
    clearTimeout(timeout)
    params.signal?.removeEventListener('abort', abort)
  }

  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success)
    throw new GuestWebSearchError(
      'Guest web search returned an unknown response shape',
      'invalid-provider-response',
    )
  const response = parsed.data
  if (
    response.status !== 'completed' ||
    response.model !== params.model ||
    response.usage.total_tokens !== response.usage.input_tokens + response.usage.output_tokens ||
    response.usage.input_tokens_details.cached_tokens > response.usage.input_tokens ||
    response.usage.output_tokens > params.maxOutputTokens
  )
    throw new GuestWebSearchError(
      'Guest web search did not complete',
      'incomplete-provider-response',
    )

  let recognizedCompletedToolCalls = 0
  let toolCallCountKnown = true
  for (const rawItem of response.output) {
    const item = z.record(z.unknown()).safeParse(rawItem)
    if (
      !item.success ||
      typeof item.data.type !== 'string' ||
      !['message', 'reasoning', 'web_search_call'].includes(item.data.type)
    ) {
      toolCallCountKnown = false
      break
    }
    if (item.data.type === 'web_search_call') {
      if (item.data.status !== 'completed') {
        toolCallCountKnown = false
        break
      }
      recognizedCompletedToolCalls += 1
    }
  }
  const observedUsage =
    toolCallCountKnown && recognizedCompletedToolCalls === 1
      ? {
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
            webSearchToolCalls: 1,
          },
        }
      : undefined
  const laterError = (
    message: string,
    code: 'invalid-provider-response' | 'incomplete-provider-response',
  ) => new GuestWebSearchError(message, code, observedUsage ? { observedUsage } : undefined)

  let text = ''
  let toolCalls = 0
  const consultedReferences = new Map<string, GuestWebSearchReference>()
  const citedReferences = new Map<string, GuestWebSearchReference>()
  for (const rawItem of response.output) {
    const item = z.record(z.unknown()).safeParse(rawItem)
    if (!item.success || typeof item.data.type !== 'string')
      throw laterError(
        'Guest web search returned an unknown output item',
        'invalid-provider-response',
      )
    if (item.data.type === 'web_search_call') {
      if (item.data.status !== 'completed')
        throw laterError(
          'Guest web search tool call did not complete',
          'incomplete-provider-response',
        )
      toolCalls += 1
      const action = z.record(z.unknown()).safeParse(item.data.action)
      const sources = action.success ? z.array(sourceSchema).safeParse(action.data.sources) : null
      if (sources?.success) {
        for (const source of sources.data) {
          const url = safeReferenceUrl(source.url, allowedDomains)
          if (!url) continue
          consultedReferences.set(url, {
            title: boundedText(source.title ?? new URL(url).hostname, MAX_TITLE_CODE_POINTS),
            url,
            cited: false,
          })
        }
      }
      continue
    }
    if (item.data.type === 'reasoning') continue
    if (item.data.type !== 'message' || item.data.status !== 'completed')
      throw laterError(
        'Guest web search returned an unsupported output item',
        'invalid-provider-response',
      )
    const content = z.array(z.unknown()).safeParse(item.data.content)
    if (!content.success)
      throw laterError(
        'Guest web search returned malformed message content',
        'invalid-provider-response',
      )
    for (const rawPart of content.data) {
      const part = z.record(z.unknown()).safeParse(rawPart)
      if (!part.success || part.data.type !== 'output_text' || typeof part.data.text !== 'string')
        throw laterError(
          'Guest web search returned unsupported message content',
          'invalid-provider-response',
        )
      text += part.data.text
      const annotations = z.array(citationSchema).safeParse(part.data.annotations)
      if (!annotations.success)
        throw laterError(
          'Guest web search returned malformed citations',
          'invalid-provider-response',
        )
      for (const citation of annotations.data) {
        const url = safeReferenceUrl(citation.url, allowedDomains)
        if (!url)
          throw laterError(
            'Guest web search returned an unsafe citation',
            'invalid-provider-response',
          )
        citedReferences.set(url, {
          title: boundedText(citation.title, MAX_TITLE_CODE_POINTS),
          url,
          cited: true,
        })
      }
    }
  }
  if (
    !text.trim() ||
    toolCalls !== params.maxToolCalls ||
    citedReferences.size < 1 ||
    citedReferences.size > params.maxResults ||
    Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_TEXT_UTF8_BYTES
  )
    throw laterError('Guest web search response was incomplete', 'incomplete-provider-response')

  return {
    provider: 'openai',
    model: response.model,
    responseId: response.id,
    text: text.normalize('NFC').trim(),
    references: [
      ...citedReferences.values(),
      ...[...consultedReferences.values()].filter(({ url }) => !citedReferences.has(url)),
    ].slice(0, params.maxResults),
    usage: {
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.input_tokens_details.cached_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.total_tokens,
      webSearchToolCalls: toolCalls,
    },
  }
}
