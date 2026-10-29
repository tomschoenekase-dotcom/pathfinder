import { afterEach, describe, expect, it, vi } from 'vitest'

import { logger, setErrorMonitor } from './logger'

describe('logger error monitor', () => {
  afterEach(() => setErrorMonitor())

  it('reports an error exactly once after writing the local log', () => {
    const sink = vi.fn()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setErrorMonitor(sink)

    logger.error({ action: 'test.failure', error: 'provider-error', tenantId: 'tenant-one' })

    expect(stdout).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'test.failure', error: '[redacted]' }),
    )
    stdout.mockRestore()
  })

  it('redacts secrets, free-form content, stacks, and unsafe nested strings before every sink', () => {
    const sink = vi.fn()
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setErrorMonitor(sink)

    logger.error({
      action: 'test.redaction',
      error: 'The provider echoed a visitor question and credential',
      stack: 'C:\\private\\workspace\\worker.ts:10',
      tenantId: 'tenant-one',
      apiToken: 'secret-token-value',
      numericPassword: 123456,
      payload: {
        prompt: 'Where is the shark feeding?',
        status: 'provider-failed',
        nested: { email: 'visitor@example.test', count: 2 },
      },
    })

    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(payload).toMatchObject({
      action: 'test.redaction',
      error: '[redacted]',
      stack: '[redacted]',
      tenantId: 'tenant-one',
      apiToken: '[redacted]',
      numericPassword: '[redacted]',
      payload: {
        prompt: '[redacted]',
        status: 'provider-failed',
        nested: { email: '[redacted]', count: 2 },
      },
    })
    expect(JSON.stringify(payload)).not.toContain('secret-token-value')
    expect(JSON.stringify(payload)).not.toContain('visitor@example.test')
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ error: '[redacted]', stack: '[redacted]' }),
    )
    stdout.mockRestore()
  })

  it('bounds circular and oversized metadata without making logging throw', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const circular: Record<string, unknown> = { status: 'running' }
    circular.self = circular

    expect(() =>
      logger.info({
        action: 'test.circular',
        tenantId: 'tenant-one',
        circular,
        attempts: Array.from({ length: 70 }, (_, index) => index),
      }),
    ).not.toThrow()

    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
      circular: { self: string }
      attempts: unknown[]
    }
    expect(payload.circular.self).toBe('[circular]')
    expect(payload.attempts).toHaveLength(65)
    expect(payload.attempts.at(-1)).toBe('[truncated]')
    stdout.mockRestore()
  })

  it('fails closed to a minimal record when hostile metadata cannot be inspected', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const hostile = Object.defineProperty({}, 'message', {
      enumerable: true,
      get() {
        throw new Error('must not escape')
      },
    })

    expect(() => logger.warn({ action: 'test.hostile', hostile })).not.toThrow()

    const payload = JSON.parse(String(stdout.mock.calls[0]?.[0])) as Record<string, unknown>
    expect(payload).toMatchObject({ action: 'sanitization-failed', sanitization: 'failed' })
    expect(payload).not.toHaveProperty('hostile')
    stdout.mockRestore()
  })

  it('does not let a monitoring failure escape', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    setErrorMonitor(() => {
      throw new Error('monitor unavailable')
    })

    expect(() => logger.error({ action: 'test.failure', error: 'original' })).not.toThrow()
    stdout.mockRestore()
  })
})


it('preserves bounded provider diagnostics and request provenance through the real sanitizer', () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  try {
    logger.error({ action: 'chat.send.ai_failed', error: 'private provider message', requestId: 'request-fixture', turnId: 'turn-fixture', routeModel: 'guest-chat-sol-fast', failureCode: 'PROVIDER_CREDITS_EXHAUSTED', providerHttpStatus: 429, providerErrorCode: 'insufficient_quota' })
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ requestId: 'request-fixture', turnId: 'turn-fixture', routeModel: 'guest-chat-sol-fast', failureCode: 'PROVIDER_CREDITS_EXHAUSTED', providerHttpStatus: 429, providerErrorCode: 'insufficient_quota', error: '[redacted]' })
  } finally { stdout.mockRestore() }
})
