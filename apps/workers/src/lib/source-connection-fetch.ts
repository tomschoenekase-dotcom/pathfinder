import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

import {
  SOURCE_CONNECTION_LIMITS,
  SourceConnectionConfigSchema,
  isApprovedSourceUrl,
  type SourceConnectionConfig,
} from '@pathfinder/contracts/source-connections'
import { isPublicIpAddress } from '@pathfinder/contracts/live-data-network'

export type SourceConnectionValidators = { etag?: string; lastModified?: string }
export type SourceConnectionHttpResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}
export type SourceConnectionFetchOutcome =
  | {
      status: 'fetched'
      body: Buffer
      contentType: string
      etag?: string
      lastModified?: string
      finalUrl: string
      requestCount: number
      bytesTransferred: number
    }
  | {
      status: 'not_modified'
      etag?: string
      lastModified?: string
      finalUrl: string
      requestCount: number
      bytesTransferred: number
    }
  | {
      status: 'failed'
      errorCategory: string
      retryable: boolean
      requestCount: number
      bytesTransferred: number
    }

export type SourceConnectionFetchDependencies = {
  resolveHostname?: (host: string) => Promise<string[]>
  request?: (input: {
    url: URL
    address: string
    timeoutMs: number
    maxBytes: number
    validators: SourceConnectionValidators
    signal: AbortSignal
  }) => Promise<SourceConnectionHttpResponse>
  /** Reserve a durable request budget slot immediately before each HTTP hop. */
  beforeRequest?: () => Promise<boolean>
  now?: () => number
}

class FetchError extends Error {
  constructor(
    readonly category: string,
    readonly retryable = false,
    readonly bytes = 0,
  ) {
    super(category)
  }
}

const resolveHostname = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address)

function validValidator(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length > 200 || /\p{Cc}/u.test(value)) throw new FetchError('validator_invalid')
  return value
}

function requestPinned(input: {
  url: URL
  address: string
  timeoutMs: number
  maxBytes: number
  validators: SourceConnectionValidators
  signal: AbortSignal
}): Promise<SourceConnectionHttpResponse> {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: input.address,
        port: 443,
        method: 'GET',
        path: `${input.url.pathname}${input.url.search}`,
        servername: input.url.hostname,
        timeout: input.timeoutMs,
        signal: input.signal,
        maxHeaderSize: 16_384,
        // Avoid a shared socket/session pool: the reviewed address is the only dial target.
        agent: false,
        headers: {
          Host: input.url.host,
          Accept: 'text/html,application/xhtml+xml,application/json,application/feed+json',
          'Accept-Encoding': 'identity',
          'User-Agent': 'TorchikoSourceConnection/1.0',
          ...(input.validators.etag ? { 'If-None-Match': input.validators.etag } : {}),
          ...(input.validators.lastModified
            ? { 'If-Modified-Since': input.validators.lastModified }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('error', (error) =>
          reject(
            error instanceof FetchError ? error : new FetchError('network_error', true, bytes),
          ),
        )
        const declared = Number(response.headers['content-length'] ?? 0)
        if (Number.isFinite(declared) && declared > input.maxBytes) {
          reject(new FetchError('payload_too_large', false, bytes))
          response.destroy()
          return
        }
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.byteLength
          receivedBytes = bytes
          if (bytes > input.maxBytes) {
            response.destroy(new FetchError('payload_too_large', false, bytes))
            return
          }
          chunks.push(buffer)
        })
        response.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[key.toLowerCase()] = value
          }
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) })
        })
      },
    )
    req.on('timeout', () => req.destroy(new FetchError('timeout', true, receivedBytes)))
    req.on('error', (error) =>
      reject(
        error instanceof FetchError ? error : new FetchError('network_error', true, receivedBytes),
      ),
    )
    req.end()
  })
}

function contentTypeAllowed(contentType: string, config: SourceConnectionConfig): boolean {
  const expected = config.mappings[0]?.type
  return expected === 'html'
    ? /^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/iu.test(contentType)
    : /^application\/(?:json|feed\+json|jsonfeed\+json)(?:\s*;|$)/iu.test(contentType)
}

function freshRemaining(deadline: number, now: () => number): number {
  const remaining = deadline - now()
  if (remaining <= 0) throw new FetchError('timeout', true)
  return remaining
}

async function bounded<T>(
  work: () => Promise<T>,
  deadline: number,
  now: () => number,
  onTimeout?: () => void,
): Promise<T> {
  const remaining = freshRemaining(deadline, now)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.()
          reject(new FetchError('timeout', true))
        }, remaining)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** No request can leave the approved exact URL list; every hop resolves and pins a public IP. */
export async function fetchSourceConnection(
  rawConfig: SourceConnectionConfig,
  validators: SourceConnectionValidators = {},
  deps: SourceConnectionFetchDependencies = {},
): Promise<SourceConnectionFetchOutcome> {
  let requestCount = 0
  let bytesTransferred = 0
  try {
    const config = SourceConnectionConfigSchema.parse(rawConfig)
    const inputEtag = validValidator(validators.etag)
    const inputLastModified = validValidator(validators.lastModified)
    const conditional: SourceConnectionValidators = {
      ...(inputEtag ? { etag: inputEtag } : {}),
      ...(inputLastModified ? { lastModified: inputLastModified } : {}),
    }
    const now = deps.now ?? Date.now
    const deadline = now() + SOURCE_CONNECTION_LIMITS.deadlineMs
    for (let attempt = 0; attempt < SOURCE_CONNECTION_LIMITS.maxAttempts; attempt += 1) {
      let current = config.sourceUrl
      try {
        for (let hop = 0; hop <= SOURCE_CONNECTION_LIMITS.maxRedirects; hop += 1) {
          freshRemaining(deadline, now)
          if (!isApprovedSourceUrl(config, current)) throw new FetchError('url_not_approved')
          const url = new URL(current)
          let addresses: string[]
          try {
            addresses = await bounded(
              () => (deps.resolveHostname ?? resolveHostname)(url.hostname),
              deadline,
              now,
            )
          } catch (error) {
            throw error instanceof FetchError ? error : new FetchError('dns_failure', true)
          }
          if (addresses.length === 0 || addresses.length > 64)
            throw new FetchError('dns_failure', true)
          if (!addresses.every(isPublicIpAddress)) throw new FetchError('blocked_address')
          const address = addresses[0]!
          if (deps.beforeRequest) {
            let admitted = false
            try {
              admitted = await bounded(deps.beforeRequest, deadline, now)
            } catch {
              /* fail closed */
            }
            if (!admitted) throw new FetchError('budget_exhausted')
          }
          const controller = new AbortController()
          const response = await bounded(
            () => {
              const timeoutMs = freshRemaining(deadline, now)
              requestCount += 1
              return (deps.request ?? requestPinned)({
                url,
                address,
                timeoutMs,
                maxBytes: SOURCE_CONNECTION_LIMITS.maxBodyBytes,
                validators: hop === 0 ? conditional : {},
                signal: controller.signal,
              })
            },
            deadline,
            now,
            () => controller.abort(),
          )
          bytesTransferred += response.body.byteLength
          if (response.body.byteLength > SOURCE_CONNECTION_LIMITS.maxBodyBytes)
            throw new FetchError('payload_too_large')
          if (response.status === 304) {
            if (hop !== 0 || (!conditional.etag && !conditional.lastModified))
              throw new FetchError('unexpected_not_modified')
            const etag = validValidator(response.headers.etag)
            const lastModified = validValidator(response.headers['last-modified'])
            return {
              status: 'not_modified',
              finalUrl: current,
              requestCount,
              bytesTransferred,
              ...(etag ? { etag } : {}),
              ...(lastModified ? { lastModified } : {}),
            }
          }
          if (response.status >= 300 && response.status < 400) {
            if (hop === SOURCE_CONNECTION_LIMITS.maxRedirects || !response.headers.location)
              throw new FetchError('redirect_blocked')
            let target: string
            if (/[\\\p{Cc}\s]/u.test(response.headers.location))
              throw new FetchError('redirect_blocked')
            try {
              target = new URL(response.headers.location, current).toString()
            } catch {
              throw new FetchError('redirect_blocked')
            }
            if (!isApprovedSourceUrl(config, target)) throw new FetchError('redirect_blocked')
            current = target
            continue
          }
          if (response.status === 429 || response.status >= 500)
            throw new FetchError('http_error', true)
          if (response.status < 200 || response.status >= 300) throw new FetchError('http_error')
          const contentType = response.headers['content-type'] ?? ''
          if (!contentTypeAllowed(contentType, config)) throw new FetchError('content_type_invalid')
          if ((response.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity')
            throw new FetchError('compressed_response_refused')
          const etag = validValidator(response.headers.etag)
          const lastModified = validValidator(response.headers['last-modified'])
          return {
            status: 'fetched',
            body: response.body,
            contentType,
            finalUrl: current,
            requestCount,
            bytesTransferred,
            ...(etag ? { etag } : {}),
            ...(lastModified ? { lastModified } : {}),
          }
        }
      } catch (error) {
        const failure = error instanceof FetchError ? error : new FetchError('network_error', true)
        bytesTransferred += failure.bytes
        if (!failure.retryable || attempt + 1 === SOURCE_CONNECTION_LIMITS.maxAttempts) {
          return {
            status: 'failed',
            errorCategory: failure.category,
            retryable: failure.retryable,
            requestCount,
            bytesTransferred,
          }
        }
      }
    }
    return {
      status: 'failed',
      errorCategory: 'attempt_limit',
      retryable: false,
      requestCount,
      bytesTransferred,
    }
  } catch {
    return {
      status: 'failed',
      errorCategory: 'config_invalid',
      retryable: false,
      requestCount,
      bytesTransferred,
    }
  }
}
