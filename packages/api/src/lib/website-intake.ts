import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

import {
  IntakeEvidence,
  IntakeProposal,
  type IntakeDiscrepancy,
  WebsiteSourceDiscovery,
  WebsitePageTextEvidenceCollection,
  type WebsitePageTextEvidence,
  type WebsiteIntakeBounds,
  WebsiteIntakeBounds as WebsiteIntakeBoundsSchema,
} from '@pathfinder/contracts/intake-engine'

import {
  VenuePackageDraftInput,
  VenuePackagePayload,
  type VenuePackageDraftInput as VenuePackageDraftInputType,
  type VenuePackagePayload as VenuePackagePayloadType,
} from '../schemas/venue-package'

const DEFAULT_MAX_DURATION_MS = 30_000
const MAX_MAX_DURATION_MS = 300_000
const DEFAULT_MAX_REDIRECTS = 5
const MAX_RESOLVED_ADDRESSES = 64
const MAX_EXTRACTED_LINKS_PER_PAGE = 500
const MAX_EXTRACTED_FACTS_PER_PAGE = 500
const MAX_DISCOVERY_REFERENCES = 1_000
export const WEBSITE_INTAKE_COLLECTION_POLICY_VERSION = 1
/**
 * Engineering work estimate only: one unit for each dispatched HTTP fetch plus
 * one unit for each started 100 kB of successfully observed response body.
 * It is neither a provider charge nor a claim about bytes in unread redirects.
 */
export const WEBSITE_INTAKE_ENGINEERING_COST_MODEL_VERSION = 2
const SENSITIVE_QUERY_KEY =
  /(?:token|key|secret|signature|credential|auth|password|^sig$|^x-amz-|^x-goog-)/iu

export class WebsiteIntakePolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebsiteIntakePolicyError'
  }
}

export type WebsiteIntakeFetchRequest = {
  url: string
  resolvedAddresses: readonly string[]
  redirectMode: 'MANUAL'
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}

export type WebsiteIntakeFetchResponse = {
  status: number
  headers: Readonly<Record<string, string | undefined>>
  body: string | Uint8Array
}

export type ExtractedWebsiteFact = {
  fieldPath: string
  value: string
  confidence: number
  locator?: string
  dateSensitive?: boolean
  effectiveDate?: string
}

export type ExtractedWebsitePage = {
  links: readonly string[]
  facts: readonly ExtractedWebsiteFact[]
  readableText?: string
  extractionProfile?: WebsitePageTextEvidence['extractionProfile']
}

export type WebsiteIntakeDependencies = {
  resolveHostname: (hostname: string) => Promise<readonly string[]>
  robots: {
    canFetch: (request: {
      url: string
      userAgent: string
      resolvedAddresses: readonly string[]
      timeoutMs: number
    }) => Promise<boolean>
  }
  fetchPage: (request: WebsiteIntakeFetchRequest) => Promise<WebsiteIntakeFetchResponse>
  extractPage: (input: {
    url: string
    body: string
    contentType?: string
  }) => Promise<ExtractedWebsitePage>
  mapToVenuePackage?: (input: WebsiteIntakeIntermediate) => Promise<VenuePackagePayloadType>
  now?: () => Date
}

export type WebsiteIntakeRequest = {
  tenantId: string
  venueId: string
  sourceId: string
  startUrl: string
  bounds: WebsiteIntakeBounds
  userAgent: string
  maxDurationMs?: number
  maxRedirects?: number
  signal?: AbortSignal
}

export type WebsiteIntakeCitation = {
  evidenceId: string
  fieldPath: string
  value: string
  sourceUrl: string
  locator: string
  confidence: number
  dateSensitive: boolean
  effectiveDate: string | null
}

export type WebsiteIntakeIntermediate = {
  schemaVersion: 1
  sourceId: string
  pages: readonly { url: string; depth: number; byteSize: number; normalizedHash: string }[]
  citations: readonly WebsiteIntakeCitation[]
  evidence: readonly IntakeEvidence[]
  discrepancies: readonly IntakeDiscrepancy[]
  pageTextEvidence?: WebsitePageTextEvidence[]
  discovery?: WebsiteSourceDiscovery
}

export type WebsiteIntakeResult = {
  proposal: IntakeProposal
  intermediate: WebsiteIntakeIntermediate
  packageBinding:
    | { kind: 'TYPED_INTERMEDIATE'; draftInput: null }
    | { kind: 'VENUE_PACKAGE_DRAFT'; draftInput: VenuePackageDraftInputType }
  nextAction: 'CREATE_DRAFT_FOR_REVIEW'
  execution: { autoPublish: false; autoApply: false; lifecycleCommands: readonly [] }
  job: {
    name: 'website-intake'
    dedupeKey: string
    runId: string
    draftKey: string
    attemptedFetches: number
    fetchedPages: number
    fetchedBytes: number
    estimatedCostUnits: number
  }
}

export function websiteIntakeEngineeringCostUnits(input: {
  attemptedFetches: number
  observedBodyBytes: number
}) {
  return input.attemptedFetches + Math.ceil(input.observedBodyBytes / 100_000)
}

type AdmittedUrl = { canonicalUrl: string; hostname: string }

type DiscoveryDisposition = WebsiteSourceDiscovery['items'][number]['disposition']

const DOCUMENT_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.epub',
  '.odt',
  '.pdf',
  '.ppt',
  '.pptx',
  '.rtf',
  '.xls',
  '.xlsx',
])
const VIDEO_EXTENSIONS = new Set([
  '.aac',
  '.avi',
  '.flac',
  '.m4a',
  '.m4v',
  '.mov',
  '.mp3',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.ogg',
  '.ogv',
  '.wav',
  '.webm',
])
const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
])

function extensionDisposition(url: string): DiscoveryDisposition | null {
  const pathname = new URL(url).pathname.toLowerCase()
  const extension = pathname.match(/\.[a-z0-9]{1,8}$/u)?.[0]
  if (!extension) return null
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'UNSUPPORTED_DOCUMENT'
  if (VIDEO_EXTENSIONS.has(extension)) return 'UNSUPPORTED_VIDEO'
  if (IMAGE_EXTENSIONS.has(extension)) return 'UNSUPPORTED_IMAGE'
  return null
}

function mimeDisposition(contentType: string): DiscoveryDisposition {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (
    !normalized ||
    normalized === 'text/html' ||
    normalized === 'application/xhtml+xml' ||
    normalized === 'text/plain'
  )
    return 'FETCHED_TEXT'
  if (
    normalized === 'application/pdf' ||
    /(?:msword|officedocument|opendocument|epub|rtf)/u.test(normalized)
  )
    return 'UNSUPPORTED_DOCUMENT'
  if (normalized.startsWith('video/') || normalized.startsWith('audio/')) return 'UNSUPPORTED_VIDEO'
  if (normalized.startsWith('image/')) return 'UNSUPPORTED_IMAGE'
  return 'UNSUPPORTED_OTHER'
}

function normalizedContentType(contentType: string) {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType.length <= 255 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : undefined
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deterministicUuid(hash: string) {
  const value = `${hash.slice(0, 12)}4${hash.slice(13, 16)}a${hash.slice(17, 20)}${hash.slice(20, 32)}`
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function normalizeHostname(hostname: string) {
  const withoutDot = hostname.trim().toLowerCase().replace(/\.$/u, '')
  if (withoutDot.startsWith('[') && withoutDot.endsWith(']')) {
    const literal = withoutDot.slice(1, -1)
    if (isIP(literal) !== 6) throw new WebsiteIntakePolicyError('Host is not valid')
    return literal
  }
  const ascii = domainToASCII(withoutDot)
  if (!ascii || ascii.includes('*')) throw new WebsiteIntakePolicyError('Host is not valid')
  return ascii
}

function normalizeAllowedHosts(hosts: readonly string[]) {
  const normalized = new Set<string>()
  for (const host of hosts) {
    const bracketedIpv6 = host.startsWith('[') && host.endsWith(']')
    if (
      host.includes('://') ||
      host.includes('/') ||
      host.includes('@') ||
      (host.includes(':') && !bracketedIpv6)
    ) {
      throw new WebsiteIntakePolicyError(
        'Allowed hosts must be exact hostnames without URLs or ports',
      )
    }
    normalized.add(normalizeHostname(host))
  }
  return normalized
}

function canonicalizeUrl(raw: string, base: string | undefined, allowedHosts: ReadonlySet<string>) {
  let url: URL
  try {
    url = base ? new URL(raw, base) : new URL(raw)
  } catch {
    throw new WebsiteIntakePolicyError('URL is not valid')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebsiteIntakePolicyError('Only HTTP(S) website URLs are allowed')
  }
  if (url.username || url.password) {
    throw new WebsiteIntakePolicyError('Credentialed URLs are not allowed')
  }
  if (
    [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some((key) =>
      SENSITIVE_QUERY_KEY.test(key),
    )
  ) {
    throw new WebsiteIntakePolicyError('Credential-bearing URL parameters are not allowed')
  }
  const hostname = normalizeHostname(url.hostname)
  if (!allowedHosts.has(hostname)) {
    throw new WebsiteIntakePolicyError(`Host ${hostname} is outside the exact allowlist`)
  }
  const expectedPort = url.protocol === 'https:' ? '443' : '80'
  if (url.port && url.port !== expectedPort) {
    throw new WebsiteIntakePolicyError('Non-default website ports are not allowed')
  }
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname
  url.port = ''
  url.hash = ''
  url.searchParams.sort()
  const canonicalUrl = url.toString()
  if (canonicalUrl.length > 2_048) {
    throw new WebsiteIntakePolicyError('Website URL exceeded its length limit')
  }
  return { canonicalUrl, hostname } satisfies AdmittedUrl
}

function ipv4Bytes(address: string) {
  const parts = address.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null
  }
  return parts as [number, number, number, number]
}

function expandIpv6(address: string) {
  const scoped = address.split('%', 1)[0] ?? address
  let normalized = scoped.toLowerCase()
  const embedded = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  if (embedded) {
    const bytes = ipv4Bytes(embedded)
    if (!bytes) return null
    const replacement = `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`
    normalized = normalized.slice(0, -embedded.length) + replacement
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (words.length !== 8 || words.some((word) => !/^[a-f0-9]{1,4}$/u.test(word))) return null
  return words.map((word) => Number.parseInt(word, 16))
}

function isBlockedIpv4(address: string) {
  const bytes = ipv4Bytes(address)
  if (!bytes) return true
  const [a, b, c] = bytes
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isBlockedIpv6(address: string) {
  const words = expandIpv6(address)
  if (!words) return true
  const [first = 0, second = 0, third = 0, fourth = 0, fifth = 0, sixth = 0] = words
  const allZero = words.every((word) => word === 0)
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1
  const mappedV4 = words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff
  if (mappedV4) {
    const seventh = words[6] ?? 0
    const eighth = words[7] ?? 0
    return isBlockedIpv4(`${seventh >> 8}.${seventh & 255}.${eighth >> 8}.${eighth & 255}`)
  }
  return (
    allZero ||
    loopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && second === 0) ||
    first === 0x2002 ||
    (first === 0x0064 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0) ||
    (first === 0x0064 && second === 0xff9b && third === 1)
  )
}

export function isPublicWebsiteAddress(address: string) {
  const version = isIP(address)
  if (version === 4) return !isBlockedIpv4(address)
  if (version === 6) return !isBlockedIpv6(address)
  return false
}

function isPrivateHostname(hostname: string) {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa') ||
    hostname === 'instance-data'
  )
}

async function resolvePublicAddresses(
  admitted: AdmittedUrl,
  resolver: WebsiteIntakeDependencies['resolveHostname'],
) {
  if (isPrivateHostname(admitted.hostname)) {
    throw new WebsiteIntakePolicyError('Private and metadata hostnames are not allowed')
  }
  const literalVersion = isIP(admitted.hostname)
  const addresses = literalVersion ? [admitted.hostname] : [...(await resolver(admitted.hostname))]
  if (addresses.length === 0) throw new WebsiteIntakePolicyError('Host did not resolve')
  if (addresses.length > MAX_RESOLVED_ADDRESSES) {
    throw new WebsiteIntakePolicyError('Host returned too many DNS addresses')
  }
  if (addresses.some((address) => !isPublicWebsiteAddress(address))) {
    throw new WebsiteIntakePolicyError('Host resolution included a non-public address')
  }
  return [...new Set(addresses)].sort()
}

function responseBody(response: WebsiteIntakeFetchResponse, maxBytes: number) {
  const body =
    typeof response.body === 'string'
      ? Buffer.from(response.body, 'utf8')
      : Buffer.from(response.body)
  if (body.byteLength > maxBytes) {
    throw new WebsiteIntakePolicyError('Website response exceeded the per-page byte limit')
  }
  return body
}

function header(response: WebsiteIntakeFetchResponse, name: string) {
  const found = Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)
  return found?.[1]
}

function normalizeClaim(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function discrepanciesFor(citations: readonly WebsiteIntakeCitation[]) {
  const byField = new Map<string, WebsiteIntakeCitation[]>()
  for (const citation of citations) {
    byField.set(citation.fieldPath, [...(byField.get(citation.fieldPath) ?? []), citation])
  }
  const discrepancies: IntakeDiscrepancy[] = []
  for (const [fieldPath, fieldCitations] of [...byField].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (new Set(fieldCitations.map((citation) => normalizeClaim(citation.value))).size < 2) continue
    const evidenceIds = [...new Set(fieldCitations.map((citation) => citation.evidenceId))].sort()
    discrepancies.push({
      id: `discrepancy_${sha256(`${fieldPath}:${evidenceIds.join(':')}`).slice(0, 24)}`,
      fieldPath,
      evidenceIds,
      reason: fieldCitations.some(
        (citation) => citation.dateSensitive || citation.effectiveDate !== null,
      )
        ? 'DATE_SENSITIVE'
        : 'CONTRADICTION',
    })
  }
  return discrepancies
}

export async function buildWebsiteIntakeProposal(
  request: WebsiteIntakeRequest,
  dependencies: WebsiteIntakeDependencies,
): Promise<WebsiteIntakeResult> {
  const bounds = WebsiteIntakeBoundsSchema.parse(request.bounds)
  if (!request.tenantId || !request.venueId || !request.sourceId || !request.userAgent.trim()) {
    throw new WebsiteIntakePolicyError('Website intake identity and user agent are required')
  }
  const maxDurationMs = request.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  if (maxDurationMs < 1 || maxDurationMs > MAX_MAX_DURATION_MS) {
    throw new WebsiteIntakePolicyError('Website intake duration is outside the allowed bounds')
  }
  const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new WebsiteIntakePolicyError('Website redirect count is outside the allowed bounds')
  }
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().getTime()
  const allowedHosts = normalizeAllowedHosts(bounds.allowedHosts)
  const start = canonicalizeUrl(request.startUrl, undefined, allowedHosts)
  if (
    isPrivateHostname(start.hostname) ||
    (isIP(start.hostname) !== 0 && !isPublicWebsiteAddress(start.hostname))
  ) {
    throw new WebsiteIntakePolicyError('Private and metadata hostnames are not allowed')
  }
  const dedupeMaterial = stableJson({
    tenantId: request.tenantId,
    venueId: request.venueId,
    sourceId: request.sourceId,
    startUrl: start.canonicalUrl,
    bounds,
    collectionPolicyVersion: WEBSITE_INTAKE_COLLECTION_POLICY_VERSION,
  })
  const dedupeKey = sha256(dedupeMaterial)
  const runId = `website_${dedupeKey.slice(0, 24)}`
  const draftKey = deterministicUuid(sha256(`draft:${dedupeKey}`))
  const queue: Array<{ admitted: AdmittedUrl; depth: number; parentUrl: string | null }> = [
    { admitted: start, depth: 0, parentUrl: null },
  ]
  const admittedReferences = new Set([start.canonicalUrl])
  const seen = new Set<string>()
  const pageTextEvidence: WebsitePageTextEvidence[] = []
  let retainedTextCodePoints = 0
  const pages: Array<{ url: string; depth: number; byteSize: number; normalizedHash: string }> = []
  const citations: WebsiteIntakeCitation[] = []
  let attemptedFetches = 0
  let fetchedBytes = 0
  let networkCandidates = 0
  let omittedDiscoveryCount = 0
  const discoveryObservedAt = now().toISOString()
  const discoveryItems: WebsiteSourceDiscovery['items'][number][] = []
  const discoveredItemUrls = new Set<string>()
  const firstUrlByExactHash = new Map<string, string>()

  const observe = (
    queued: { admitted: AdmittedUrl; depth: number; parentUrl: string | null },
    disposition: DiscoveryDisposition,
    received?: {
      contentType: string
      byteSize: number
      exactByteHash: string
      duplicateOf?: string
    },
  ) => {
    if (discoveredItemUrls.has(queued.admitted.canonicalUrl)) return
    discoveredItemUrls.add(queued.admitted.canonicalUrl)
    discoveryItems.push({
      url: queued.admitted.canonicalUrl,
      parentUrl: queued.parentUrl,
      depth: queued.depth,
      observedAt: now().toISOString(),
      disposition,
      ...(received
        ? {
            ...(normalizedContentType(received.contentType)
              ? { contentType: normalizedContentType(received.contentType) }
              : {}),
            byteSize: received.byteSize,
            exactByteHash: received.exactByteHash,
            ...(received.duplicateOf ? { duplicateOf: received.duplicateOf } : {}),
          }
        : {}),
    })
  }

  const safelyAdmitChild = (raw: string, parent: AdmittedUrl, depth: number) => {
    let child: AdmittedUrl
    try {
      child = canonicalizeUrl(raw, parent.canonicalUrl, allowedHosts)
      if (
        isPrivateHostname(child.hostname) ||
        (isIP(child.hostname) !== 0 && !isPublicWebsiteAddress(child.hostname))
      )
        return
    } catch (error) {
      if (error instanceof WebsiteIntakePolicyError) return
      throw error
    }
    if (admittedReferences.has(child.canonicalUrl)) return
    if (admittedReferences.size >= MAX_DISCOVERY_REFERENCES) {
      omittedDiscoveryCount += 1
      return
    }
    admittedReferences.add(child.canonicalUrl)
    const reference = { admitted: child, depth, parentUrl: parent.canonicalUrl }
    const unsupported = extensionDisposition(child.canonicalUrl)
    if (unsupported) observe(reference, unsupported)
    else queue.push(reference)
  }

  const remainingTime = () => {
    if (request.signal?.aborted) throw new WebsiteIntakePolicyError('Website intake was cancelled')
    const remaining = maxDurationMs - (now().getTime() - startedAt)
    if (remaining <= 0) throw new WebsiteIntakePolicyError('Website intake exceeded its time limit')
    return remaining
  }

  while (queue.length > 0 && networkCandidates < bounds.maxPages) {
    const queued = queue.shift()
    if (!queued || seen.has(queued.admitted.canonicalUrl)) continue
    seen.add(queued.admitted.canonicalUrl)
    remainingTime()
    const knownUnsupported = extensionDisposition(queued.admitted.canonicalUrl)
    if (knownUnsupported) {
      observe(queued, knownUnsupported)
      continue
    }
    networkCandidates += 1
    let admitted = queued.admitted
    let observationReference = queued
    const redirects = new Set<string>()
    let response: WebsiteIntakeFetchResponse | null = null

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      remainingTime()
      if (redirects.has(admitted.canonicalUrl)) {
        throw new WebsiteIntakePolicyError('Website redirect loop detected')
      }
      redirects.add(admitted.canonicalUrl)
      const resolvedAddresses = await resolvePublicAddresses(admitted, dependencies.resolveHostname)
      remainingTime()
      const timeoutMs = remainingTime()
      const robotsAllowed = await dependencies.robots.canFetch({
        url: admitted.canonicalUrl,
        userAgent: request.userAgent,
        resolvedAddresses,
        timeoutMs,
      })
      remainingTime()
      if (!robotsAllowed) {
        observe(observationReference, 'ROBOTS_DENIED')
        break
      }
      attemptedFetches += 1
      response = await dependencies.fetchPage({
        url: admitted.canonicalUrl,
        resolvedAddresses,
        redirectMode: 'MANUAL',
        maxBytes: bounds.maxBytesPerPage,
        timeoutMs: remainingTime(),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      remainingTime()
      if (response.status >= 300 && response.status < 400) {
        const location = header(response, 'location')
        if (!location) throw new WebsiteIntakePolicyError('Website redirect omitted its location')
        if (redirectCount === maxRedirects) {
          throw new WebsiteIntakePolicyError('Website exceeded its redirect limit')
        }
        const redirectSourceUrl = admitted.canonicalUrl
        admitted = canonicalizeUrl(location, redirectSourceUrl, allowedHosts)
        if (
          isPrivateHostname(admitted.hostname) ||
          (isIP(admitted.hostname) !== 0 && !isPublicWebsiteAddress(admitted.hostname))
        ) {
          throw new WebsiteIntakePolicyError('Website redirect targeted a non-public host')
        }
        if (!admittedReferences.has(admitted.canonicalUrl)) {
          if (admittedReferences.size >= MAX_DISCOVERY_REFERENCES) {
            omittedDiscoveryCount += 1
            response = null
            break
          }
          admittedReferences.add(admitted.canonicalUrl)
        } else if (discoveredItemUrls.has(admitted.canonicalUrl)) {
          response = null
          break
        }
        observationReference = {
          admitted,
          depth: queued.depth,
          parentUrl: redirectSourceUrl,
        }
        const unsupported = extensionDisposition(admitted.canonicalUrl)
        if (unsupported) {
          observe(observationReference, unsupported)
          response = null
          break
        }
        seen.add(admitted.canonicalUrl)
        response = null
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new WebsiteIntakePolicyError(`Website returned HTTP ${response.status}`)
      }
      break
    }

    if (!response) continue
    const body = responseBody(response, bounds.maxBytesPerPage)
    fetchedBytes += body.byteLength
    const normalizedHash = sha256(body)
    const contentType = header(response, 'content-type') ?? ''
    const disposition = mimeDisposition(contentType)
    const duplicateOf = firstUrlByExactHash.get(normalizedHash)
    if (!duplicateOf) firstUrlByExactHash.set(normalizedHash, admitted.canonicalUrl)
    observe(observationReference, disposition, {
      contentType,
      byteSize: body.byteLength,
      exactByteHash: normalizedHash,
      ...(duplicateOf ? { duplicateOf } : {}),
    })
    if (disposition !== 'FETCHED_TEXT') continue
    pages.push({
      url: admitted.canonicalUrl,
      depth: queued.depth,
      byteSize: body.byteLength,
      normalizedHash,
    })
    const extracted = await dependencies.extractPage({
      url: admitted.canonicalUrl,
      body: body.toString('utf8'),
      contentType,
    })
    remainingTime()
    if ((extracted.readableText === undefined) !== (extracted.extractionProfile === undefined)) {
      throw new WebsiteIntakePolicyError('Extractor text requires its extraction profile')
    }
    if (extracted.readableText !== undefined && extracted.extractionProfile !== undefined) {
      if (extracted.readableText.length > 20_000_000) {
        throw new WebsiteIntakePolicyError('Extractor text exceeded its size limit')
      }
      const retained: string[] = []
      const retentionLimit = Math.min(20_000, 100_000 - retainedTextCodePoints)
      let fullCodePointCount = 0
      for (const codePoint of extracted.readableText) {
        if (fullCodePointCount < retentionLimit) retained.push(codePoint)
        fullCodePointCount += 1
      }
      const text = retained.join('')
      const retainedCodePointCount = retained.length
      pageTextEvidence.push({
        sourceUrl: admitted.canonicalUrl,
        exactByteHash: normalizedHash,
        capturedAt: now().toISOString(),
        extractionProfile: extracted.extractionProfile,
        text,
        normalizedTextHash: sha256(extracted.readableText),
        retainedTextHash: sha256(text),
        fullCodePointCount,
        retainedCodePointCount,
        truncated: retainedCodePointCount < fullCodePointCount,
      })
      retainedTextCodePoints += retainedCodePointCount
    }
    if (extracted.links.length > MAX_EXTRACTED_LINKS_PER_PAGE) {
      throw new WebsiteIntakePolicyError('Extractor returned too many links')
    }
    if (extracted.facts.length > MAX_EXTRACTED_FACTS_PER_PAGE) {
      throw new WebsiteIntakePolicyError('Extractor returned too many facts')
    }
    for (const fact of extracted.facts) {
      if (
        !fact.fieldPath.trim() ||
        !fact.value.trim() ||
        fact.confidence < 0 ||
        fact.confidence > 1
      ) {
        throw new WebsiteIntakePolicyError('Extractor returned an invalid fact')
      }
      if (fact.effectiveDate && Number.isNaN(Date.parse(fact.effectiveDate))) {
        throw new WebsiteIntakePolicyError('Extractor returned an invalid effective date')
      }
      const locator = fact.locator
        ? `${admitted.canonicalUrl}#${fact.locator.replace(/^#/u, '')}`
        : admitted.canonicalUrl
      const evidenceHash = sha256(
        stableJson({
          sourceId: request.sourceId,
          url: admitted.canonicalUrl,
          locator,
          fieldPath: fact.fieldPath,
          value: normalizeClaim(fact.value),
        }),
      )
      const evidenceId = `evidence_${evidenceHash.slice(0, 24)}`
      citations.push({
        evidenceId,
        fieldPath: fact.fieldPath.trim(),
        value: fact.value.trim(),
        sourceUrl: admitted.canonicalUrl,
        locator: locator.slice(0, 2_000),
        confidence: fact.confidence,
        dateSensitive: fact.dateSensitive === true,
        effectiveDate: fact.effectiveDate ?? null,
      })
    }
    if (queued.depth < bounds.maxDepth) {
      for (const link of extracted.links) {
        remainingTime()
        safelyAdmitChild(link, admitted, queued.depth + 1)
      }
    } else {
      for (const link of extracted.links) {
        remainingTime()
        let child: AdmittedUrl
        try {
          child = canonicalizeUrl(link, admitted.canonicalUrl, allowedHosts)
          if (
            isPrivateHostname(child.hostname) ||
            (isIP(child.hostname) !== 0 && !isPublicWebsiteAddress(child.hostname))
          )
            continue
        } catch (error) {
          if (error instanceof WebsiteIntakePolicyError) continue
          throw error
        }
        if (admittedReferences.has(child.canonicalUrl)) continue
        if (admittedReferences.size >= MAX_DISCOVERY_REFERENCES) {
          omittedDiscoveryCount += 1
          continue
        }
        admittedReferences.add(child.canonicalUrl)
        observe(
          { admitted: child, depth: queued.depth + 1, parentUrl: admitted.canonicalUrl },
          extensionDisposition(child.canonicalUrl) ?? 'DEPTH_LIMIT',
        )
      }
    }
  }

  for (const queued of queue) {
    remainingTime()
    observe(queued, 'PAGE_LIMIT')
  }

  const uniqueCitations = [
    ...new Map(citations.map((item) => [item.evidenceId, item])).values(),
  ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  const evidence = uniqueCitations.map((citation) =>
    IntakeEvidence.parse({
      id: citation.evidenceId,
      sourceId: request.sourceId,
      locator: citation.locator,
      capturedAt: now().toISOString(),
      normalizedHash: sha256(normalizeClaim(citation.value)),
      confidence: citation.confidence,
    }),
  )
  const discrepancies = discrepanciesFor(uniqueCitations)
  const discovery = WebsiteSourceDiscovery.parse({
    policyVersion: WEBSITE_INTAKE_COLLECTION_POLICY_VERSION,
    observedAt: discoveryObservedAt,
    items: discoveryItems,
    omittedCount: omittedDiscoveryCount,
  })
  const intermediate: WebsiteIntakeIntermediate = {
    schemaVersion: 1,
    sourceId: request.sourceId,
    pages,
    ...(pageTextEvidence.length > 0
      ? { pageTextEvidence: WebsitePageTextEvidenceCollection.parse(pageTextEvidence) }
      : {}),
    citations: uniqueCitations,
    evidence,
    discrepancies,
    discovery,
  }
  const payload = dependencies.mapToVenuePackage
    ? VenuePackagePayload.parse(await dependencies.mapToVenuePackage(intermediate))
    : null
  const packageBinding = payload
    ? {
        kind: 'VENUE_PACKAGE_DRAFT' as const,
        draftInput: VenuePackageDraftInput.parse({
          venueId: request.venueId,
          payload,
          draftKey,
        }),
      }
    : ({ kind: 'TYPED_INTERMEDIATE', draftInput: null } as const)
  const proposal = IntakeProposal.parse({
    runId,
    status: 'AWAITING_REVIEW',
    sourceIds: [request.sourceId],
    evidenceIds: evidence.map((item) => item.id),
    discrepancyIds: discrepancies.map((item) => item.id),
    autoPublish: false,
  })
  return {
    proposal,
    intermediate,
    packageBinding,
    nextAction: 'CREATE_DRAFT_FOR_REVIEW',
    execution: { autoPublish: false, autoApply: false, lifecycleCommands: [] },
    job: {
      name: 'website-intake',
      dedupeKey,
      runId,
      draftKey,
      attemptedFetches,
      fetchedPages: pages.length,
      fetchedBytes,
      estimatedCostUnits: websiteIntakeEngineeringCostUnits({
        attemptedFetches,
        observedBodyBytes: fetchedBytes,
      }),
    },
  }
}
