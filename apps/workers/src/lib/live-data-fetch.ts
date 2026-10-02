import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'

import {
  LIVE_DATA_LIMITS,
  checkLiveDataEndpoint,
  isLiveDataHostAllowed,
  type LiveDataErrorCategory,
} from '@pathfinder/contracts/live-data'
import { isPublicIpAddress } from '@pathfinder/contracts/live-data-network'

/**
 * SSRF-hardened, read-only JSON fetch for venue live-data connectors.
 *
 * Defences, applied on EVERY hop (the first request and each redirect):
 * - static URL checks (https, port 443, no credentials, no IP literals, no internal names);
 * - platform host allowlist (fails closed in production when unset);
 * - the host name is resolved here and EVERY returned address must be globally routable, so a
 *   name that resolves to loopback, RFC1918, link-local, or cloud-metadata space is refused;
 * - the connection is pinned to the validated address (TLS SNI and Host keep the real name), so a
 *   second DNS answer cannot redirect the connection after validation;
 * - redirects are followed manually, at most twice, and re-validated; no cookies or credentials;
 * - hard per-request timeout, response-size ceiling (declared and streamed), JSON only.
 */

export type LiveDataHttpResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export type LiveDataFetchOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; errorCategory: LiveDataErrorCategory; retryable: boolean }

export type LiveDataFetchDependencies = {
  resolveHostname?: (hostname: string) => Promise<string[]>
  request?: (input: {
    url: URL
    address: string
    timeoutMs: number
    maxBytes: number
  }) => Promise<LiveDataHttpResponse>
  allowlist: readonly string[]
  production: boolean
}

class FetchFailure extends Error {
  constructor(
    readonly errorCategory: LiveDataErrorCategory,
    readonly retryable = false,
  ) {
    super(errorCategory)
    this.name = 'LiveDataFetchFailure'
  }
}

const defaultResolveHostname = async (hostname: string): Promise<string[]> =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address)

function defaultRequest(input: {
  url: URL
  address: string
  timeoutMs: number
  maxBytes: number
}): Promise<LiveDataHttpResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = httpsRequest(
      {
        protocol: 'https:',
        hostname: input.address,
        port: 443,
        method: 'GET',
        path: `${input.url.pathname}${input.url.search}`,
        servername: input.url.hostname,
        timeout: input.timeoutMs,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'identity',
          Host: input.url.host,
          'User-Agent': 'Torchiko-LiveData/1.0',
        },
      },
      (response) => {
        const declared = Number(response.headers['content-length'] ?? 0)
        if (declared > input.maxBytes) {
          response.destroy()
          reject(new FetchFailure('payload_too_large'))
          return
        }
        const chunks: Buffer[] = []
        let received = 0
        response.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += bytes.byteLength
          if (received > input.maxBytes) {
            response.destroy()
            reject(new FetchFailure('payload_too_large'))
            return
          }
          chunks.push(bytes)
        })
        response.on('error', () => reject(new FetchFailure('network_error', true)))
        response.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(response.headers)) {
            if (typeof value === 'string') headers[key.toLowerCase()] = value
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    clientRequest.on('timeout', () => clientRequest.destroy(new FetchFailure('timeout', true)))
    clientRequest.on('error', (error) =>
      reject(error instanceof FetchFailure ? error : new FetchFailure('network_error', true)),
    )
    clientRequest.end()
  })
}

async function validatedAddress(url: URL, deps: LiveDataFetchDependencies): Promise<string> {
  const check = checkLiveDataEndpoint(url.toString())
  if (!check.ok) throw new FetchFailure(check.errorCategory)
  if (!isLiveDataHostAllowed(check.host, deps.allowlist, { production: deps.production }))
    throw new FetchFailure('host_not_allowed')
  let addresses: string[]
  try {
    addresses = await (deps.resolveHostname ?? defaultResolveHostname)(check.host)
  } catch {
    throw new FetchFailure('dns_failure', true)
  }
  if (addresses.length === 0) throw new FetchFailure('dns_failure', true)
  // Every answer must be public: a mixed answer is how DNS rebinding hides a private target.
  if (!addresses.every(isPublicIpAddress)) throw new FetchFailure('blocked_address')
  return addresses[0]!
}

export async function fetchLiveDataJson(
  rawUrl: string,
  deps: LiveDataFetchDependencies,
): Promise<LiveDataFetchOutcome> {
  try {
    let current: URL
    try {
      current = new URL(rawUrl)
    } catch {
      throw new FetchFailure('host_not_allowed')
    }
    for (let hop = 0; hop <= LIVE_DATA_LIMITS.maxRedirects; hop += 1) {
      const address = await validatedAddress(current, deps)
      const response = await (deps.request ?? defaultRequest)({
        url: current,
        address,
        timeoutMs: LIVE_DATA_LIMITS.requestTimeoutMs,
        maxBytes: LIVE_DATA_LIMITS.maxPayloadBytes,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location
        if (!location || hop === LIVE_DATA_LIMITS.maxRedirects)
          throw new FetchFailure('redirect_blocked')
        try {
          current = new URL(location, current)
        } catch {
          throw new FetchFailure('redirect_blocked')
        }
        continue
      }
      if (response.status < 200 || response.status >= 300)
        throw new FetchFailure('http_error', response.status >= 500 || response.status === 429)
      if (response.body.byteLength > LIVE_DATA_LIMITS.maxPayloadBytes)
        throw new FetchFailure('payload_too_large')
      try {
        return { ok: true, payload: JSON.parse(response.body.toString('utf8')) as unknown }
      } catch {
        throw new FetchFailure('invalid_json')
      }
    }
    throw new FetchFailure('redirect_blocked')
  } catch (error) {
    if (error instanceof FetchFailure)
      return { ok: false, errorCategory: error.errorCategory, retryable: error.retryable }
    return { ok: false, errorCategory: 'network_error', retryable: true }
  }
}
