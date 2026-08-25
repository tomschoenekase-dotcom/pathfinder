import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rateLimit = vi.hoisted(() => vi.fn())
vi.mock('../lib/rate-limit', () => ({ checkRateLimit: rateLimit }))

import { router } from '../core'
import type { TRPCContext } from '../context'
import { publicInterestRouter } from './public-interest'

const findUnique = vi.fn()
const create = vi.fn()
const caller = (headers = new Headers()) =>
  router({ publicInterest: publicInterestRouter }).createCaller({
    db: { publicInterestSubmission: { findUnique, create } } as unknown as TRPCContext['db'],
    headers,
    session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
  }).publicInterest

const input = {
  requestId: '11111111-1111-4111-8111-111111111111',
  organizationName: 'River Museum',
  contactName: 'Avery Guide',
  workEmail: 'Avery@Example.com',
  website: 'https://example.com',
  cityRegion: 'St. Louis, MO',
  venueType: 'Museum',
  message: 'We would like to understand remote setup.',
}

describe('public interest intake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rateLimit.mockResolvedValue(true)
    findUnique.mockResolvedValue(null)
    create.mockResolvedValue({ id: 'interest-1' })
  })

  it('stores bounded staged evidence without creating CRM or delivery effects', async () => {
    await expect(
      caller(new Headers({ 'x-forwarded-for': '203.0.113.10' })).submit(input),
    ).resolves.toEqual({ received: true })
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: input.requestId,
        organizationName: 'River Museum',
        workEmail: 'Avery@Example.com',
        normalizedEmail: 'avery@example.com',
        sourcePath: '/request-demo',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      select: { id: true },
    })
    expect(rateLimit.mock.calls.flat().join(':')).not.toContain('203.0.113.10')
    expect(rateLimit.mock.calls.flat().join(':')).not.toContain('avery@example.com')
  })

  it('accepts an exact replay without creating a second row', async () => {
    await caller().submit(input)
    const hash = create.mock.calls[0]?.[0].data.requestHash
    findUnique.mockResolvedValue({ requestHash: hash })
    await expect(caller().submit(input)).resolves.toEqual({ received: true })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects a request id replay with changed evidence', async () => {
    findUnique.mockResolvedValue({ requestHash: 'a'.repeat(64) })
    await expect(caller().submit(input)).rejects.toMatchObject({
      code: 'CONFLICT',
    } satisfies Partial<TRPCError>)
    expect(create).not.toHaveBeenCalled()
  })

  it('does not retain honeypot submissions', async () => {
    await expect(caller().submit({ ...input, companyFax: 'robot' })).resolves.toEqual({
      received: true,
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('fails closed when either bounded rate limit denies the request', async () => {
    rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(
      caller(new Headers({ 'cf-connecting-ip': '203.0.113.11' })).submit(input),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' } satisfies Partial<TRPCError>)
    expect(create).not.toHaveBeenCalled()
  })
})
