import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceConnectionConfigSchema } from '@pathfinder/contracts/source-connections'

const transport = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ request: transport.request }))

import { fetchSourceConnection } from './source-connection-fetch'

const sourceUrl = 'https://venue.example.com/program'
const config = SourceConnectionConfigSchema.parse({
  version: 1,
  sourceUrl,
  allowedUrls: [sourceUrl],
  timezone: 'UTC',
  mappings: [
    {
      type: 'json_feed',
      kind: 'description',
      itemsPointer: '/items',
      idPointer: '/id',
      titlePointer: '/title',
      textPointer: '/text',
      dateFormat: 'iso',
    },
  ],
  refreshIntervalSeconds: 900,
  freshnessSeconds: 86_400,
  validation: { minRecords: 1, maxRecords: 10, maxChangedFraction: 0.5, maxRequestsPerDay: 24 },
  publicationPolicy: 'review_required',
})

class Response extends EventEmitter {
  statusCode = 200
  headers: Record<string, string> = { 'content-type': 'application/json' }
  destroyed = false
  destroy(error?: Error) {
    this.destroyed = true
    if (error) this.emit('error', error)
    return this
  }
}

function stubResponse(sample: Response, send: () => void) {
  const request = new EventEmitter() as EventEmitter & {
    end: () => void
    destroy: (error?: Error) => void
  }
  request.end = () =>
    queueMicrotask(() => {
      transport.request.mock.calls[0]![1](sample)
      send()
    })
  request.destroy = (error) => {
    if (error) request.emit('error', error)
  }
  transport.request.mockReturnValue(request)
}

describe('native pinned HTTPS source transport', () => {
  beforeEach(() => transport.request.mockReset())

  it('dials only the reviewed IP with TLS SNI/Host, no pooling and an explicit header cap', async () => {
    const sample = new Response()
    stubResponse(sample, () => {
      sample.emit('data', Buffer.from('{}'))
      sample.emit('end')
    })
    expect(
      await fetchSourceConnection(config, {}, { resolveHostname: async () => ['93.184.216.34'] }),
    ).toMatchObject({ status: 'fetched', requestCount: 1, bytesTransferred: 2 })
    expect(transport.request.mock.calls[0]![0]).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'venue.example.com',
      port: 443,
      path: '/program',
      agent: false,
      maxHeaderSize: 16_384,
      headers: { Host: 'venue.example.com', 'Accept-Encoding': 'identity' },
    })
  })

  it('rejects declared oversize safely before subscribing to data', async () => {
    const sample = new Response()
    sample.headers['content-length'] = '1000001'
    stubResponse(sample, () => {})
    expect(
      await fetchSourceConnection(config, {}, { resolveHostname: async () => ['93.184.216.34'] }),
    ).toMatchObject({
      status: 'failed',
      errorCategory: 'payload_too_large',
      requestCount: 1,
      retryable: false,
    })
    expect(sample.destroyed).toBe(true)
    expect(sample.listenerCount('error')).toBe(1)
    expect(sample.listenerCount('data')).toBe(0)
  })

  it('destroys chunked oversize streams and reports their bytes without retrying', async () => {
    const sample = new Response()
    stubResponse(sample, () => {
      sample.emit('data', Buffer.alloc(800_000))
      sample.emit('data', Buffer.alloc(200_001))
    })
    expect(
      await fetchSourceConnection(config, {}, { resolveHostname: async () => ['93.184.216.34'] }),
    ).toMatchObject({
      status: 'failed',
      errorCategory: 'payload_too_large',
      requestCount: 1,
      bytesTransferred: 1_000_001,
    })
    expect(sample.destroyed).toBe(true)
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})
