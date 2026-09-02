import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'

import {
  WebsiteIntakePolicyError,
  type ExtractedWebsiteFact,
  type WebsiteIntakeDependencies,
  type WebsiteIntakeFetchRequest,
  type WebsiteIntakeFetchResponse,
} from './website-intake'

const ROBOTS_MAX_BYTES = 256_000

function normalizedHeaders(headers: IncomingHttpHeaders) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  )
}

function byteLength(body: string | Uint8Array) {
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength
}

async function pinnedFetch(
  request: WebsiteIntakeFetchRequest,
  userAgent: string,
): Promise<WebsiteIntakeFetchResponse> {
  const url = new URL(request.url)
  const address = request.resolvedAddresses[0]
  if (!address) throw new WebsiteIntakePolicyError('Host did not resolve')
  if (request.signal?.aborted) throw new WebsiteIntakePolicyError('Website intake was cancelled')
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: address,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: {
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
      'Accept-Encoding': 'identity',
      Host: url.host,
      'User-Agent': userAgent,
    },
    timeout: request.timeoutMs,
    ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
  }
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    const clientRequest = transport(options, (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (declaredLength > request.maxBytes) {
        response.destroy()
        reject(new WebsiteIntakePolicyError('Website response exceeded its byte limit'))
        return
      }
      const chunks: Buffer[] = []
      let received = 0
      response.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        received += bytes.byteLength
        if (received > request.maxBytes) {
          response.destroy(new WebsiteIntakePolicyError('Website response exceeded its byte limit'))
          return
        }
        chunks.push(bytes)
      })
      response.on('error', reject)
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: normalizedHeaders(response.headers),
          body: Buffer.concat(chunks),
        })
      })
    })
    const abort = () =>
      clientRequest.destroy(new WebsiteIntakePolicyError('Website intake was cancelled'))
    request.signal?.addEventListener('abort', abort, { once: true })
    clientRequest.on('timeout', () =>
      clientRequest.destroy(new WebsiteIntakePolicyError('Website intake exceeded its time limit')),
    )
    clientRequest.on('error', reject)
    clientRequest.on('close', () => request.signal?.removeEventListener('abort', abort))
    clientRequest.end()
  })
}

type RobotsRule = { allow: boolean; pattern: string }

export function robotsAllows(body: string, targetUrl: string, userAgent: string) {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = []
  let current: { agents: string[]; rules: RobotsRule[] } | null = null
  let rulesStarted = false
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (key === 'user-agent') {
      if (!current || rulesStarted) {
        current = { agents: [], rules: [] }
        groups.push(current)
        rulesStarted = false
      }
      current.agents.push(value.toLowerCase())
    } else if ((key === 'allow' || key === 'disallow') && current) {
      rulesStarted = true
      if (value) current.rules.push({ allow: key === 'allow', pattern: value })
    }
  }
  const normalizedAgent = userAgent.toLowerCase()
  const matches = groups
    .map((group) => ({
      group,
      specificity: Math.max(
        -1,
        ...group.agents.map((agent) =>
          agent === '*' ? 0 : normalizedAgent.includes(agent) ? agent.length : -1,
        ),
      ),
    }))
    .filter(({ specificity }) => specificity >= 0)
  if (!matches.length) return true
  const strongest = Math.max(...matches.map(({ specificity }) => specificity))
  const path = `${new URL(targetUrl).pathname}${new URL(targetUrl).search}`
  const matchingRules = matches
    .filter(({ specificity }) => specificity === strongest)
    .flatMap(({ group }) => group.rules)
    .filter((rule) => {
      const anchored = rule.pattern.endsWith('$')
      const source = rule.pattern
        .replace(/\$$/u, '')
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('.*')
      return new RegExp(`^${source}${anchored ? '$' : ''}`, 'u').test(path)
    })
    .sort(
      (left, right) =>
        right.pattern.length - left.pattern.length || Number(right.allow) - Number(left.allow),
    )
  return matchingRules[0]?.allow ?? true
}

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&nbsp;/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const items = value.map(stringValue).filter((item): item is string => Boolean(item))
    return items.length ? items.join('; ') : null
  }
  return null
}

function jsonLdFacts(document: unknown): ExtractedWebsiteFact[] {
  const nodes = Array.isArray(document)
    ? document
    : document && typeof document === 'object' && '@graph' in document
      ? Array.isArray((document as Record<string, unknown>)['@graph'])
        ? (document as { '@graph': unknown[] })['@graph']
        : [document]
      : [document]
  const facts: ExtractedWebsiteFact[] = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const record = node as Record<string, unknown>
    const address =
      typeof record.address === 'object' && record.address
        ? [
            (record.address as Record<string, unknown>).streetAddress,
            (record.address as Record<string, unknown>).addressLocality,
            (record.address as Record<string, unknown>).addressRegion,
            (record.address as Record<string, unknown>).postalCode,
          ]
            .map(stringValue)
            .filter(Boolean)
            .join(', ')
        : stringValue(record.address)
    const mappings: Array<[string, string | null, number, boolean]> = [
      ['venue.name', stringValue(record.name), 0.95, false],
      ['venue.description', stringValue(record.description), 0.9, false],
      ['venue.phone', stringValue(record.telephone), 0.9, false],
      ['venue.email', stringValue(record.email), 0.9, false],
      ['venue.address', address || null, 0.9, false],
      ['venue.hours', stringValue(record.openingHours), 0.85, true],
      ['venue.website', stringValue(record.url), 0.9, false],
    ]
    for (const [fieldPath, value, confidence, dateSensitive] of mappings) {
      if (value) facts.push({ fieldPath, value, confidence, dateSensitive, locator: 'json-ld' })
    }
  }
  return facts
}

export function extractWebsitePage(input: { url: string; body: string }) {
  const links = [...input.body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/giu)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .slice(0, 500)
  const facts: ExtractedWebsiteFact[] = []
  for (const match of input.body.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    try {
      facts.push(...jsonLdFacts(JSON.parse(match[1] ?? 'null')))
    } catch {
      // Malformed optional JSON-LD is ignored; it is never evidence.
    }
  }
  const title = input.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1]
  if (title && decodeHtml(title)) {
    facts.push({
      fieldPath: 'venue.pageTitle',
      value: decodeHtml(title),
      confidence: 0.65,
      locator: 'title',
    })
  }
  const description = input.body.match(
    /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])(?=[^>]*\bcontent\s*=\s*["']([^"']+)["'])[^>]*>/iu,
  )?.[1]
  if (description && decodeHtml(description)) {
    facts.push({
      fieldPath: 'venue.description',
      value: decodeHtml(description),
      confidence: 0.65,
      locator: 'meta-description',
    })
  }
  return {
    links,
    facts: [
      ...new Map(
        facts.slice(0, 500).map((fact) => [`${fact.fieldPath}:${fact.value}`, fact]),
      ).values(),
    ],
  }
}

export function createWebsiteIntakeRuntimeDependencies(options: {
  userAgent: string
}): WebsiteIntakeDependencies {
  return {
    resolveHostname: async (hostname) => {
      const resolved = await lookup(hostname, { all: true, verbatim: true })
      return resolved.map(({ address }) => address)
    },
    robots: {
      canFetch: async ({ url, resolvedAddresses, timeoutMs }) => {
        const robotsUrl = new URL('/robots.txt', url).toString()
        const response = await pinnedFetch(
          {
            url: robotsUrl,
            resolvedAddresses,
            redirectMode: 'MANUAL',
            maxBytes: ROBOTS_MAX_BYTES,
            timeoutMs,
          },
          options.userAgent,
        )
        if (response.status === 404 || response.status === 410) return true
        if (response.status === 401 || response.status === 403) return false
        if (response.status < 200 || response.status >= 300) {
          throw new WebsiteIntakePolicyError(`Website robots returned HTTP ${response.status}`)
        }
        return robotsAllows(Buffer.from(response.body).toString('utf8'), url, options.userAgent)
      },
    },
    fetchPage: async (request) => {
      const response = await pinnedFetch(request, options.userAgent)
      if (response.status >= 200 && response.status < 300) {
        const contentType = response.headers['content-type']?.toLowerCase() ?? ''
        if (
          contentType &&
          !contentType.includes('text/html') &&
          !contentType.includes('application/xhtml+xml') &&
          !contentType.includes('text/plain')
        ) {
          throw new WebsiteIntakePolicyError('Website returned a non-text page')
        }
        if (byteLength(response.body) > request.maxBytes) {
          throw new WebsiteIntakePolicyError('Website response exceeded its byte limit')
        }
      }
      return response
    },
    extractPage: async (input) => extractWebsitePage(input),
  }
}
