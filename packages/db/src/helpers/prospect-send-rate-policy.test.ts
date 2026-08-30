import { describe, expect, it } from 'vitest'

import { evaluateProspectSendRatePolicy } from './prospect-send-rate-policy'

const base = {
  now: new Date('2026-08-22T16:00:00.000Z'),
  operationId: '00000000-0000-0000-0000-000000000001',
  mailboxDailyCap: 10,
  campaignDailyCap: 10,
  domainDailyCap: 2,
  mailboxReservedToday: 0,
  campaignReservedToday: 0,
  domainReservedToday: 0,
  minimumDelaySeconds: 180,
  jitterSeconds: 0,
  lastReservedAt: null,
}

describe('prospect send rate policy', () => {
  it.each([
    ['mailbox', { mailboxReservedToday: 10 }],
    ['campaign', { campaignReservedToday: 10 }],
    ['recipient domain', { domainReservedToday: 2 }],
  ])('defers at the next UTC day when the %s cap is exhausted', (_name, counts) => {
    expect(evaluateProspectSendRatePolicy({ ...base, ...counts })).toEqual({
      allowed: false,
      retryAt: new Date('2026-08-23T00:00:00.000Z'),
      reason: 'DAILY_CAP',
    })
  })

  it('enforces spacing from the latest live reservation', () => {
    expect(
      evaluateProspectSendRatePolicy({
        ...base,
        lastReservedAt: new Date('2026-08-22T15:58:00.000Z'),
      }),
    ).toEqual({
      allowed: false,
      retryAt: new Date('2026-08-22T16:01:00.000Z'),
      reason: 'MINIMUM_DELAY',
    })
  })

  it('allows a send when every configured lane has capacity and spacing', () => {
    expect(
      evaluateProspectSendRatePolicy({
        ...base,
        lastReservedAt: new Date('2026-08-22T15:56:59.000Z'),
      }),
    ).toEqual({ allowed: true })
  })
})
