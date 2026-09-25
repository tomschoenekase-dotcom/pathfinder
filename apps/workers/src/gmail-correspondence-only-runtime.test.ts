import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/config', () => ({
  env: { OUTBOUND_PROVIDER_WORKERS_ENABLED: false },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/db', () => ({ updateJobRecord: vi.fn() }))
vi.mock('./processors/gmail-sync', () => ({ processGmailSyncJob: sync }))

import {
  GMAIL_SYNC_FULL_RECONCILIATION_JOB,
  GMAIL_SYNC_NOTIFICATION_JOB,
  GMAIL_SYNC_RECONCILIATION_JOB,
  GMAIL_SYNC_WATCH_RENEWAL_JOB,
} from '@pathfinder/jobs'
import { processGmailCorrespondenceOnlyJob } from './gmail-correspondence-only-runtime'

const source = readFileSync(resolve(__dirname, 'gmail-correspondence-only-runtime.ts'), 'utf8')

describe('provider-disabled Gmail correspondence runtime', () => {
  beforeEach(() => sync.mockReset())

  it('registers only Gmail sync and contains no email-delivery consumer', () => {
    expect(source).toContain('new Worker(')
    expect(source).toContain('GMAIL_SYNC_QUEUE')
    expect(source).not.toContain('SEND_EMAIL_QUEUE')
    expect(source).not.toContain('startWorkers')
  })

  it('routes an exact-account full backfill to reconciliation', async () => {
    const payload = {
      providerAccountId: 'account-1',
      trigger: 'FULL_RECONCILIATION' as const,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    sync.mockResolvedValue({ mode: 'FULL_RECONCILIATION', processed: 12 })

    await expect(
      processGmailCorrespondenceOnlyJob({
        name: GMAIL_SYNC_FULL_RECONCILIATION_JOB,
        data: payload,
      } as never),
    ).resolves.toEqual({ mode: 'FULL_RECONCILIATION', processed: 12 })
    expect(sync).toHaveBeenCalledWith(payload)
  })

  it.each([
    [
      GMAIL_SYNC_NOTIFICATION_JOB,
      { providerAccountId: 'account-1', trigger: 'PUBSUB_NOTIFICATION' },
    ],
    [
      GMAIL_SYNC_RECONCILIATION_JOB,
      { providerAccountId: 'account-1', trigger: 'SCHEDULED_RECONCILIATION' },
    ],
  ])('accepts correspondence job %s for one account', async (name, data) => {
    sync.mockResolvedValue({ processed: 1 })
    await expect(processGmailCorrespondenceOnlyJob({ name, data } as never)).resolves.toEqual({
      processed: 1,
    })
  })

  it('skips watch renewal without calling Google watch APIs', async () => {
    await expect(
      processGmailCorrespondenceOnlyJob({
        name: GMAIL_SYNC_WATCH_RENEWAL_JOB,
        data: { providerAccountId: 'account-1', trigger: 'WATCH_RENEWAL' },
      } as never),
    ).resolves.toEqual({ skipped: 'watch-renewal-disabled' })
    expect(sync).not.toHaveBeenCalled()
  })

  it('rejects wildcard account jobs before processing', async () => {
    await expect(
      processGmailCorrespondenceOnlyJob({
        name: GMAIL_SYNC_RECONCILIATION_JOB,
        data: { providerAccountId: '*', trigger: 'SCHEDULED_RECONCILIATION' },
      } as never),
    ).rejects.toThrow('one exact provider account')
    expect(sync).not.toHaveBeenCalled()
  })
})
