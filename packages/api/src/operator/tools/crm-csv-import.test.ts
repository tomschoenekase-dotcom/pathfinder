import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }))
vi.mock('node:https', () => ({ request: network.request }))

import { CsvImportError, downloadCsvAttachment, parseBoundedCsv } from './crm-csv-import'

type ResponseSpec = {
  status: number
  body?: Buffer
  location?: string
  declaredLength?: number
  chunks?: Buffer[]
}

const attachment = (url = 'https://files.example.test/upload.csv') => ({
  download_url: url,
  file_id: 'synthetic-csv',
  mime_type: 'text/csv',
})

function mockResponses(...specs: ResponseSpec[]) {
  const pending = [...specs]
  network.request.mockImplementation((options: unknown, callback: unknown) => {
    const spec = pending.shift()
    if (!spec) throw new Error('Unexpected HTTPS request')
    const req = new EventEmitter() as EventEmitter & {
      end: () => void
      destroy: (error: Error) => void
    }
    req.destroy = (error) => {
      req.emit('error', error)
      req.emit('close')
    }
    req.end = () => {
      const incoming = new EventEmitter() as EventEmitter & {
        statusCode: number
        headers: Record<string, string>
        destroy: (error?: Error) => void
      }
      incoming.statusCode = spec.status
      incoming.headers = {
        ...(spec.location ? { location: spec.location } : {}),
        ...(spec.declaredLength ? { 'content-length': String(spec.declaredLength) } : {}),
      }
      incoming.destroy = (error) => {
        if (error) incoming.emit('error', error)
      }
      ;(callback as (response: typeof incoming) => void)(incoming)
      queueMicrotask(() => {
        for (const chunk of spec.chunks ?? [spec.body ?? Buffer.from('Venue Name\nExample Hall')]) {
          incoming.emit('data', chunk)
        }
        incoming.emit('end')
        req.emit('close')
      })
    }
    // The request options are inspected by the DNS pinning tests.
    void options
    return req
  })
}

beforeEach(() => {
  network.lookup.mockReset()
  network.request.mockReset()
  network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})
afterEach(() => vi.restoreAllMocks())

describe('bounded CSV parsing', () => {
  it('handles BOM, CRLF, escaped quotes, comma and newline inside a quoted cell', () => {
    expect(
      parseBoundedCsv(
        '\uFEFFVenue Name,Notes\r\n"Example, Hall","First ""quoted"" line\nSecond line"\r\n',
      ),
    ).toEqual({
      headers: ['Venue Name', 'Notes'],
      rows: [['Example, Hall', 'First "quoted" line\nSecond line']],
    })
  })

  it('rejects malformed quoting and mismatched row widths', () => {
    for (const csv of [
      'Venue Name\n"unfinished',
      'Venue Name\nbad"quote',
      'Venue Name\n"done"suffix',
      'Venue Name,City\nExample Hall',
    ]) {
      expect(() => parseBoundedCsv(csv)).toThrowError(CsvImportError)
    }
  })

  it('rejects duplicate or empty headers and a header-only file', () => {
    for (const csv of [
      'Venue Name,venue name\nExample Hall,Alias',
      'Venue Name,\nExample Hall,Chicago',
      'Venue Name',
    ]) {
      expect(() => parseBoundedCsv(csv)).toThrowError(CsvImportError)
    }
  })

  it('accepts 500 data rows and rejects the 501st', () => {
    const rows = Array.from({ length: 500 }, (_, index) => `Example Hall ${index}`)
    expect(parseBoundedCsv(['Venue Name', ...rows].join('\n')).rows).toHaveLength(500)
    expect(() => parseBoundedCsv(['Venue Name', ...rows, 'One more'].join('\n'))).toThrow(
      'row limit',
    )
  })

  it('enforces column, cell and UTF-8 byte bounds independently', () => {
    expect(() =>
      parseBoundedCsv(
        `${Array.from({ length: 51 }, (_, i) => `H${i}`).join(',')}\n${Array(51).fill('x').join(',')}`,
      ),
    ).toThrow('header')
    expect(() => parseBoundedCsv(`Venue Name\n${'x'.repeat(65_537)}`)).toThrow('cell')
    expect(() => parseBoundedCsv(`Venue Name\n${'💡'.repeat(25_000)}`)).toThrow('byte limit')
  })
})

describe('CSV attachment download', () => {
  it('pins a public DNS address while retaining the original TLS and Host name', async () => {
    mockResponses({ status: 200, body: Buffer.from('Venue Name\nExample Hall') })
    await expect(downloadCsvAttachment(attachment())).resolves.toBe('Venue Name\nExample Hall')
    expect(network.lookup).toHaveBeenCalledWith('files.example.test', { all: true, verbatim: true })
    expect(network.request).toHaveBeenCalledTimes(1)
    expect(network.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'files.example.test',
      port: 443,
      method: 'GET',
      path: '/upload.csv',
      headers: { Host: 'files.example.test' },
    })
  })

  it('refuses unsafe URL forms before DNS or HTTPS', async () => {
    for (const url of [
      'http://files.example.test/upload.csv',
      'https://localhost/upload.csv',
      'https://127.0.0.1/upload.csv',
      'https://93.184.216.34/upload.csv',
      'https://user:pass@files.example.test/upload.csv',
      'https://files.example.test:8443/upload.csv',
      'not a URL',
    ]) {
      await expect(downloadCsvAttachment(attachment(url))).rejects.toMatchObject({
        code: 'FETCH_FAILED',
      })
    }
    expect(network.lookup).not.toHaveBeenCalled()
    expect(network.request).not.toHaveBeenCalled()
  })

  it('refuses a host with any private DNS answer before requesting', async () => {
    network.lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.2', family: 4 },
    ])
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    expect(network.request).not.toHaveBeenCalled()
  })

  it('rechecks DNS on a public redirect and refuses a private second hop', async () => {
    mockResponses({ status: 302, location: 'https://second.example.test/next.csv' })
    network.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.5', family: 4 }])
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    expect(network.lookup).toHaveBeenCalledTimes(2)
    expect(network.request).toHaveBeenCalledTimes(1)
  })

  it('refuses redirects to loopback without a second network request', async () => {
    mockResponses({ status: 302, location: 'https://127.0.0.1/private.csv' })
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    expect(network.request).toHaveBeenCalledTimes(1)
    expect(network.lookup).toHaveBeenCalledTimes(1)
  })

  it('does not reuse the pre-DNS timeout budget for the HTTPS request', async () => {
    const instants = [1_000, 1_000, 16_001]
    vi.spyOn(Date, 'now').mockImplementation(() => instants.shift() ?? 16_001)
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    expect(network.lookup).toHaveBeenCalledTimes(1)
    expect(network.request).not.toHaveBeenCalled()
  })

  it('normalizes a malformed redirect to a fetch refusal', async () => {
    mockResponses({ status: 302, location: 'https://%' })
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    expect(network.request).toHaveBeenCalledTimes(1)
  })

  it('rejects declared and streamed byte overflows and non-UTF-8 content', async () => {
    mockResponses({ status: 200, declaredLength: 100_001 })
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    mockResponses({ status: 200, chunks: [Buffer.alloc(70_000), Buffer.alloc(30_001)] })
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({
      code: 'FETCH_FAILED',
    })
    mockResponses({ status: 200, body: Buffer.from([0xc3, 0x28]) })
    await expect(downloadCsvAttachment(attachment())).rejects.toMatchObject({ code: 'INVALID_CSV' })
  })
})
