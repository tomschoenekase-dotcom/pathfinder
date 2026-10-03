import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

import {
  canonicalizeUrl,
  header,
  isPrivateHostname,
  isPublicWebsiteAddress,
  normalizeAllowedHosts,
  resolvePublicAddresses,
  responseBody,
  WebsiteIntakePolicyError,
  type WebsiteIntakeDependencies,
} from './website-intake'

/**
 * Bounded, SSRF-safe capture of one public web source into frozen evidence. It reuses the website
 * intake primitives (public-address resolution with DNS pinning, canonical URLs, robots, bounded
 * pinned fetch, HTML and PDF text extraction) and adds what a source snapshot must record per
 * input: final URL, the redirect chain, a content hash, the retrieval time, the parser version
 * and one disposition. It never writes content, never follows an instruction found in the text,
 * and never reaches a host the venue has not authorized.
 */
export const VENUE_SOURCE_PARSER_VERSION = 'venue-source-v1+static-html-v1+pdfjs-document-v1'
export const VENUE_SOURCE_LIMITS = {
  defaultMaxPages: 5,
  maxPagesCeiling: 10,
  defaultMaxBytesPerPage: 1_000_000,
  maxBytesPerPageCeiling: 2_000_000,
  maxRedirects: 3,
  maxDurationMs: 45_000,
  perFetchTimeoutMs: 10_000,
  maxTextCodePoints: 20_000,
  maxLinksPerPage: 100,
  /** Rows kept for links that were seen but not fetched, so a page limit is visible, not silent. */
  maxSkippedRows: 20,
} as const

export type VenueSourceDisposition = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNSUPPORTED' | 'SKIPPED'
export type VenueSourceStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED'

export type VenueSourceRedirect = { from: string; to: string; status: number }

export type VenueSourceInputSnapshot = {
  ordinal: number
  requestedUrl: string
  finalUrl: string | null
  redirectChain: VenueSourceRedirect[]
  disposition: VenueSourceDisposition
  reasonCode: string | null
  httpStatus: number | null
  contentType: string | null
  byteSize: number | null
  contentHash: string | null
  retrievedAt: Date
  parserVersion: string
  extractedText: string | null
  textTruncated: boolean
}

export type VenueSourceCapture = {
  status: VenueSourceStatus
  errorCode: string | null
  inputs: VenueSourceInputSnapshot[]
}

export type VenueSourceDependencies = Pick<
  WebsiteIntakeDependencies,
  'resolveHostname' | 'robots' | 'fetchPage' | 'extractPage' | 'extractPdfPage'
> & { now?: () => Date }

export type VenueSourceCaptureRequest = {
  startUrl: string
  /** Hosts the venue has authorized. A URL, a link or a redirect outside them is never fetched. */
  authorizedHosts: readonly string[]
  maxPages?: number
  maxBytesPerPage?: number
  userAgent: string
  signal?: AbortSignal
}

type Draft = Omit<VenueSourceInputSnapshot, 'ordinal' | 'retrievedAt' | 'parserVersion'>
type Fetched = { input: Draft; links: string[] }

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function mediaType(contentType: string | undefined) {
  const value = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return value.length > 0 &&
    value.length <= 200 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value)
    ? value
    : null
}

/** Control characters other than tab and newline never belong in stored text. */
function cleanText(value: string) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
}

function truncate(value: string, limit: number) {
  const points = [...value]
  return points.length > limit
    ? { text: points.slice(0, limit).join(''), truncated: true }
    : { text: value, truncated: false }
}

function blank(requestedUrl: string, chain: VenueSourceRedirect[]): Draft {
  return {
    requestedUrl,
    finalUrl: null,
    redirectChain: chain,
    disposition: 'FAILED',
    reasonCode: null,
    httpStatus: null,
    contentType: null,
    byteSize: null,
    contentHash: null,
    extractedText: null,
    textTruncated: false,
  }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/exceeded.*byte limit|per-page byte limit/iu.test(message)) return 'RESPONSE_TOO_LARGE'
  if (/time limit|timed out|cancelled/iu.test(message)) return 'TIME_LIMIT'
  if (/did not resolve/iu.test(message)) return 'DNS_FAILED'
  if (/non-public|private and metadata/iu.test(message)) return 'NON_PUBLIC_ADDRESS'
  return 'FETCH_FAILED'
}

export async function captureVenueSource(
  request: VenueSourceCaptureRequest,
  dependencies: VenueSourceDependencies,
): Promise<VenueSourceCapture> {
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().getTime()
  const maxPages = Math.min(
    request.maxPages ?? VENUE_SOURCE_LIMITS.defaultMaxPages,
    VENUE_SOURCE_LIMITS.maxPagesCeiling,
  )
  const maxBytes = Math.min(
    request.maxBytesPerPage ?? VENUE_SOURCE_LIMITS.defaultMaxBytesPerPage,
    VENUE_SOURCE_LIMITS.maxBytesPerPageCeiling,
  )
  const allowed = normalizeAllowedHosts(request.authorizedHosts)

  const remaining = () => {
    if (request.signal?.aborted) throw new WebsiteIntakePolicyError('Source capture was cancelled')
    const left = VENUE_SOURCE_LIMITS.maxDurationMs - (now().getTime() - startedAt)
    if (left <= 0) throw new WebsiteIntakePolicyError('Source capture exceeded its time limit')
    return left
  }

  /** One URL, with every redirect hop re-admitted: allowlist, scheme, address and robots. */
  async function fetchOne(requestedUrl: string, parent: string | undefined): Promise<Fetched> {
    const chain: VenueSourceRedirect[] = []
    let current = requestedUrl
    let base = parent
    const visited = new Set<string>()
    for (let hop = 0; hop <= VENUE_SOURCE_LIMITS.maxRedirects; hop += 1) {
      const draft = blank(requestedUrl, chain)
      let admitted: ReturnType<typeof canonicalizeUrl>
      try {
        admitted = canonicalizeUrl(current, base, allowed)
        if (!admitted.canonicalUrl.startsWith('https://')) {
          throw new WebsiteIntakePolicyError('Only https sources are allowed')
        }
        if (
          isPrivateHostname(admitted.hostname) ||
          (isIP(admitted.hostname) !== 0 && !isPublicWebsiteAddress(admitted.hostname))
        ) {
          throw new WebsiteIntakePolicyError('Private and metadata hostnames are not allowed')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        const unauthorized = /outside the exact allowlist/iu.test(message)
        const insecure = /only https/iu.test(message)
        return {
          input: {
            ...draft,
            disposition: unauthorized && hop === 0 ? 'SKIPPED' : 'FAILED',
            reasonCode: unauthorized
              ? hop === 0
                ? 'HOST_NOT_AUTHORIZED'
                : 'REDIRECT_HOST_NOT_AUTHORIZED'
              : insecure
                ? 'NOT_HTTPS'
                : 'NON_PUBLIC_ADDRESS',
          },
          links: [],
        }
      }
      if (visited.has(admitted.canonicalUrl)) {
        return { input: { ...draft, reasonCode: 'REDIRECT_LOOP' }, links: [] }
      }
      visited.add(admitted.canonicalUrl)
      let resolvedAddresses: readonly string[]
      try {
        // Resolution is checked here, after DNS, for the start URL and again for every redirect.
        resolvedAddresses = await resolvePublicAddresses(admitted, dependencies.resolveHostname)
      } catch (error) {
        // A resolver that throws (for example an unknown host) is a DNS failure, not a fetch.
        const reasonCode =
          error instanceof WebsiteIntakePolicyError ? failureCode(error) : 'DNS_FAILED'
        return { input: { ...draft, reasonCode }, links: [] }
      }
      try {
        const canFetch = await dependencies.robots.canFetch({
          url: admitted.canonicalUrl,
          userAgent: request.userAgent,
          resolvedAddresses,
          timeoutMs: Math.min(VENUE_SOURCE_LIMITS.perFetchTimeoutMs, remaining()),
        })
        if (!canFetch) {
          return {
            input: { ...draft, disposition: 'SKIPPED', reasonCode: 'ROBOTS_DISALLOWED' },
            links: [],
          }
        }
      } catch (error) {
        return { input: { ...draft, reasonCode: failureCode(error) }, links: [] }
      }
      let response: Awaited<ReturnType<WebsiteIntakeDependencies['fetchPage']>>
      try {
        response = await dependencies.fetchPage({
          url: admitted.canonicalUrl,
          resolvedAddresses,
          redirectMode: 'MANUAL',
          maxBytes: maxBytes,
          timeoutMs: Math.min(VENUE_SOURCE_LIMITS.perFetchTimeoutMs, remaining()),
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch (error) {
        return { input: { ...draft, reasonCode: failureCode(error) }, links: [] }
      }
      if (response.status >= 300 && response.status < 400) {
        const location = header(response, 'location')
        if (!location || hop === VENUE_SOURCE_LIMITS.maxRedirects) {
          return {
            input: {
              ...draft,
              httpStatus: response.status,
              reasonCode: location ? 'TOO_MANY_REDIRECTS' : 'REDIRECT_WITHOUT_LOCATION',
            },
            links: [],
          }
        }
        let target: string
        try {
          target = new URL(location, admitted.canonicalUrl).toString()
        } catch {
          return { input: { ...draft, reasonCode: 'REDIRECT_INVALID' }, links: [] }
        }
        chain.push({
          from: admitted.canonicalUrl,
          to: target.slice(0, 2_000),
          status: response.status,
        })
        current = target
        base = undefined
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        return {
          input: {
            ...draft,
            finalUrl: admitted.canonicalUrl,
            httpStatus: response.status,
            reasonCode: `HTTP_${response.status}`,
          },
          links: [],
        }
      }
      return processBody(requestedUrl, chain, admitted.canonicalUrl, response)
    }
    return { input: { ...blank(requestedUrl, chain), reasonCode: 'TOO_MANY_REDIRECTS' }, links: [] }
  }

  async function processBody(
    requestedUrl: string,
    chain: VenueSourceRedirect[],
    finalUrl: string,
    response: Awaited<ReturnType<WebsiteIntakeDependencies['fetchPage']>>,
  ): Promise<Fetched> {
    let body: Buffer
    try {
      body = responseBody(response, maxBytes)
    } catch (error) {
      return {
        input: {
          ...blank(requestedUrl, chain),
          finalUrl,
          httpStatus: response.status,
          reasonCode: failureCode(error),
        },
        links: [],
      }
    }
    const rawType = header(response, 'content-type') ?? ''
    const type = mediaType(rawType)
    const base: Draft = {
      ...blank(requestedUrl, chain),
      finalUrl,
      httpStatus: response.status,
      contentType: type,
      byteSize: body.byteLength,
      contentHash: sha256(body),
    }
    const isPdf =
      type === 'application/pdf' || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')
    if (isPdf) {
      if (!dependencies.extractPdfPage) {
        return {
          input: { ...base, disposition: 'UNSUPPORTED', reasonCode: 'PDF_NOT_SUPPORTED' },
          links: [],
        }
      }
      let result: Awaited<ReturnType<NonNullable<WebsiteIntakeDependencies['extractPdfPage']>>>
      try {
        result = await dependencies.extractPdfPage({
          url: finalUrl,
          bytes: body,
          timeoutMs: Math.min(15_000, remaining()),
          ...(request.signal ? { signal: request.signal } : {}),
        })
      } catch {
        result = { outcome: 'FAILED', errorCode: 'PDF_PARSE_FAILED' }
      }
      if (result.outcome === 'FAILED') {
        return {
          input: { ...base, disposition: 'FAILED', reasonCode: result.errorCode },
          links: [],
        }
      }
      return { input: textInput(base, result.readableText), links: [] }
    }
    const readable =
      type === null ||
      type === 'text/html' ||
      type === 'application/xhtml+xml' ||
      type === 'text/plain'
    if (!readable) {
      return {
        input: { ...base, disposition: 'UNSUPPORTED', reasonCode: 'UNSUPPORTED_CONTENT_TYPE' },
        links: [],
      }
    }
    try {
      const extracted = await dependencies.extractPage({
        url: finalUrl,
        body: body.toString('utf8'),
        contentType: rawType,
      })
      return {
        input: textInput(base, extracted.readableText ?? ''),
        links: extracted.links.slice(0, VENUE_SOURCE_LIMITS.maxLinksPerPage),
      }
    } catch {
      return {
        input: { ...base, disposition: 'FAILED', reasonCode: 'EXTRACTION_FAILED' },
        links: [],
      }
    }
  }

  function textInput(base: Draft, raw: string): Draft {
    const cleaned = cleanText(raw)
    const { text, truncated } = truncate(cleaned, VENUE_SOURCE_LIMITS.maxTextCodePoints)
    if (text.trim().length === 0) {
      return {
        ...base,
        disposition: 'PARTIAL',
        reasonCode: 'NO_READABLE_TEXT',
        extractedText: null,
      }
    }
    return {
      ...base,
      disposition: truncated ? 'PARTIAL' : 'SUCCEEDED',
      reasonCode: truncated ? 'TEXT_TRUNCATED' : null,
      extractedText: text,
      textTruncated: truncated,
    }
  }

  const inputs: VenueSourceInputSnapshot[] = []
  const finish = (draft: Draft) => {
    inputs.push({
      ...draft,
      ordinal: inputs.length,
      retrievedAt: now(),
      parserVersion: VENUE_SOURCE_PARSER_VERSION,
    })
  }

  let errorCode: string | null = null
  const queue: Array<{ url: string; parent: string | undefined }> = [
    { url: request.startUrl, parent: undefined },
  ]
  const queued = new Set<string>([request.startUrl])
  let fetched = 0
  let skippedRows = 0
  const skip = (url: string, reasonCode: string) => {
    if (skippedRows >= VENUE_SOURCE_LIMITS.maxSkippedRows) return
    skippedRows += 1
    finish({ ...blank(url, []), disposition: 'SKIPPED', reasonCode })
  }

  try {
    while (queue.length > 0) {
      const next = queue.shift()!
      if (fetched >= maxPages) {
        skip(next.url, 'PAGE_LIMIT')
        continue
      }
      remaining()
      fetched += 1
      const result = await fetchOne(next.url, next.parent)
      finish(result.input)
      if (result.input.disposition !== 'SUCCEEDED' && result.input.disposition !== 'PARTIAL')
        continue
      for (const link of result.links) {
        let absolute: string
        try {
          const url = new URL(link, result.input.finalUrl ?? next.url)
          url.hash = ''
          absolute = url.toString()
        } catch {
          continue
        }
        if (queued.has(absolute) || queued.size >= maxPages + VENUE_SOURCE_LIMITS.maxSkippedRows)
          continue
        queued.add(absolute)
        let host: string
        try {
          const parsed = new URL(absolute)
          if (parsed.protocol !== 'https:') {
            if (parsed.protocol === 'http:') skip(absolute, 'NOT_HTTPS')
            continue
          }
          host = [...normalizeAllowedHosts([parsed.hostname])][0] ?? ''
        } catch {
          continue
        }
        if (!allowed.has(host)) {
          skip(absolute, 'HOST_NOT_AUTHORIZED')
          continue
        }
        queue.push({ url: absolute, parent: undefined })
      }
    }
  } catch (error) {
    errorCode = failureCode(error)
  }

  const succeeded = inputs.filter((input) => input.disposition === 'SUCCEEDED').length
  const partial = inputs.some((input) => input.disposition === 'PARTIAL')
  const clean = inputs.every(
    (input) => input.disposition === 'SUCCEEDED' || input.disposition === 'SKIPPED',
  )
  const status: VenueSourceStatus =
    errorCode !== null
      ? succeeded > 0 || partial
        ? 'PARTIAL'
        : 'FAILED'
      : succeeded > 0 && clean
        ? 'SUCCEEDED'
        : succeeded > 0 || partial
          ? 'PARTIAL'
          : 'FAILED'
  return { status, errorCode, inputs }
}
