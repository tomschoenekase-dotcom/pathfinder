import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  failQueued: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  env: {
    CLIENT_NOTIFICATION_EMAIL_ENABLED: true,
    RESEND_API_KEY: 'test-resend-key' as string | undefined,
    RESEND_FROM_EMAIL: 'hello@example.com' as string | undefined,
    DASHBOARD_URL: 'https://dashboard.example.com' as string | undefined,
  },
}))

vi.mock('resend', () => ({ Resend: vi.fn(() => ({ emails: { send: mocks.send } })) }))
vi.mock('@pathfinder/config', () => ({
  env: mocks.env,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({
  beginClientNotificationEmailDelivery: mocks.begin,
  completeClientNotificationEmailDelivery: mocks.complete,
  failQueuedClientNotificationEmail: mocks.failQueued,
  supportRequestPortalPath: (venueId: string, requestId: string) =>
    `/support?venue=${encodeURIComponent(venueId)}&request=${encodeURIComponent(requestId)}`,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import {
  _setClientNotificationResendClientForTesting,
  processSendClientNotificationEmailJob,
  renderClientNotificationEmail,
} from './send-client-notification-email'

const payload = { tenantId: 'tenant_1', intentId: 'intent_1', generation: 1 }
const items = [
  {
    text: 'What are the weekend opening hours?',
    why: 'Visitors ask every day',
    effect: 'The guide answers hours correctly',
    requestId: 'request_1',
    questionId: 'question_1',
  },
  { text: 'Is parking free?', requestId: 'request_2', questionId: 'question_2' },
]
const content = {
  version: 1 as const,
  subject: 'Two questions about your venue',
  intro: 'We are setting up your guide.',
  items,
}
const sendDecision = {
  action: 'send' as const,
  intentId: 'intent_1',
  generation: 1,
  venueId: 'venue_1',
  to: 'owner@example.com',
  content,
  openItems: items,
}

describe('renderClientNotificationEmail', () => {
  it('contains every open question and its own canonical portal link', () => {
    const email = renderClientNotificationEmail({
      content,
      openItems: items,
      venueId: 'venue_1',
      portalOrigin: 'https://dashboard.example.com/',
    })
    for (const body of [email.text, email.html]) {
      expect(body).toContain('What are the weekend opening hours?')
      expect(body).toContain('Is parking free?')
    }
    expect(email.text).toContain(
      'https://dashboard.example.com/support?venue=venue_1&request=request_1',
    )
    expect(email.text).toContain(
      'https://dashboard.example.com/support?venue=venue_1&request=request_2',
    )
    expect(email.html).toContain(
      'https://dashboard.example.com/support?venue=venue_1&amp;request=request_1',
    )
    expect(email.text).toContain('Why we are asking: Visitors ask every day')
    expect(email.subject).toBe('Two questions about your venue')
  })

  it('leaves out a question that is no longer open and escapes markup', () => {
    const email = renderClientNotificationEmail({
      content,
      openItems: [{ ...items[1]!, text: '<script>alert(1)</script>' }],
      venueId: 'venue_1',
      portalOrigin: 'https://dashboard.example.com',
    })
    expect(email.text).not.toContain('weekend opening hours')
    expect(email.text).toContain('We need one answer from you.')
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
  })
})

describe('processSendClientNotificationEmailJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setClientNotificationResendClientForTesting(null)
    mocks.env.CLIENT_NOTIFICATION_EMAIL_ENABLED = true
    mocks.env.RESEND_API_KEY = 'test-resend-key'
    mocks.env.RESEND_FROM_EMAIL = 'hello@example.com'
    mocks.env.DASHBOARD_URL = 'https://dashboard.example.com'
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.begin.mockResolvedValue(sendDecision)
    mocks.complete.mockResolvedValue({ recorded: true })
    mocks.failQueued.mockResolvedValue(undefined)
    mocks.send.mockResolvedValue({ data: { id: 'provider_1' }, error: null })
  })

  it('sends the questions and links to the exact recipient once and records it as sent', async () => {
    await processSendClientNotificationEmailJob(payload)

    expect(mocks.send).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.send.mock.calls[0]!
    expect(message.to).toBe('owner@example.com')
    expect(message.from).toBe('Torchiko <hello@example.com>')
    expect(message.text).toContain('What are the weekend opening hours?')
    expect(message.text).toContain(
      'https://dashboard.example.com/support?venue=venue_1&request=request_1',
    )
    expect(options.idempotencyKey).toMatch(/^client-notification-[a-f0-9]{64}$/u)
    expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0]!,
    )
    expect(mocks.complete).toHaveBeenCalledWith({
      ...payload,
      outcome: { kind: 'sent', providerMessageId: 'provider_1' },
    })
  })

  it('sends nothing and claims nothing while the default-off switch is off', async () => {
    mocks.env.CLIENT_NOTIFICATION_EMAIL_ENABLED = false

    await processSendClientNotificationEmailJob(payload)

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.failQueued).toHaveBeenCalledWith({
      ...payload,
      errorCode: 'EMAIL_DELIVERY_DISABLED',
    })
  })

  it.each([
    ['RESEND_API_KEY', 'EMAIL_PROVIDER_NOT_CONFIGURED'],
    ['RESEND_FROM_EMAIL', 'EMAIL_PROVIDER_NOT_CONFIGURED'],
    ['DASHBOARD_URL', 'PORTAL_URL_NOT_CONFIGURED'],
  ] as const)('does not send without %s', async (field, code) => {
    mocks.env[field] = undefined

    await processSendClientNotificationEmailJob(payload)

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.failQueued).toHaveBeenCalledWith({ ...payload, errorCode: code })
  })

  it.each([
    'ALREADY_SENT',
    'UNKNOWN_NEEDS_RECONCILIATION',
    'SUPERSEDED',
    'STALE_GENERATION',
  ] as const)('does not send when the intent says %s', async (reason) => {
    mocks.begin.mockResolvedValue({ action: 'skip', reason })

    await processSendClientNotificationEmailJob(payload)

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('records a provider refusal as failed without rethrowing', async () => {
    mocks.send.mockResolvedValue({ data: null, error: { name: 'validation_error' } })

    await expect(processSendClientNotificationEmailJob(payload)).resolves.toBeUndefined()

    expect(mocks.complete).toHaveBeenCalledWith({
      ...payload,
      outcome: { kind: 'failed', errorCode: 'PROVIDER_REJECTED' },
    })
  })

  it('records an interrupted provider call as unknown and never retries it in-process', async () => {
    mocks.send.mockRejectedValue(new Error('socket hang up'))

    await expect(processSendClientNotificationEmailJob(payload)).resolves.toBeUndefined()

    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.complete).toHaveBeenCalledWith({
      ...payload,
      outcome: { kind: 'unknown', errorCode: 'PROVIDER_CALL_INTERRUPTED' },
    })
  })
})
