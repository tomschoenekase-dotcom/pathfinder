import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({ env: { RAILWAY_ENVIRONMENT: 'staging' } }))
vi.mock('@pathfinder/db', () => ({
  findTerminalJobRecordEvidenceById: vi.fn(),
  writeAuditLogStrict: vi.fn(),
}))

import { TerminalRedriveRefusal } from '@pathfinder/jobs'
import type { TRPCContext } from '../../context'
import { router } from '../../core'
import {
  adminTerminalRedrivePreviewRouter,
  previewTerminalJobRedrive,
} from './terminal-redrive-preview'

const testRouter = router({ admin: adminTerminalRedrivePreviewRouter })

const evidence = {
  id: 'record_1',
  queue: 'staging--weekly-report',
  jobName: 'weekly-report-process',
  bullJobId: 'weekly-report-report_1',
  tenantId: 'tenant_1',
  payload: { tenantId: 'tenant_1', reportId: 'report_1', private: 'never return' },
  status: 'FAILED',
  attemptNumber: 6,
  maxAttempts: 6,
  failureDisposition: 'ATTEMPTS_EXHAUSTED',
  terminalAt: new Date('2026-08-23T12:00:00.000Z'),
}

const livePreview = {
  queueName: evidence.queue,
  bullJobId: evidence.bullJobId,
  jobName: evidence.jobName,
  terminalAt: evidence.terminalAt.toISOString(),
  attemptsMade: 6,
  attemptsStarted: 6,
  maxAttempts: 6,
  payloadDigest: 'b'.repeat(64),
  confirmationToken: `terminal-redrive-${'a'.repeat(64)}`,
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    environment: 'staging',
    loadEvidence: vi.fn().mockResolvedValue(evidence),
    inspect: vi.fn().mockResolvedValue(livePreview),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('terminal redrive preview', () => {
  it('rejects non-admin sessions before reading recovery evidence', async () => {
    const context: TRPCContext = {
      db: {} as TRPCContext['db'],
      headers: new Headers(),
      session: {
        userId: 'user_1',
        activeTenantId: 'tenant_1',
        role: null,
        isPlatformAdmin: false,
      },
    }

    await expect(
      testRouter.createCaller(context).admin.previewTerminalJobRedrive({
        jobRecordId: evidence.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns bounded live evidence only after strict audit', async () => {
    const deps = dependencies()
    const result = await previewTerminalJobRedrive(
      { jobRecordId: evidence.id },
      'operator_1',
      deps as never,
    )

    expect(result).toEqual({
      schemaVersion: 1,
      effect: 'READ_ONLY',
      preview: livePreview,
      boundaries: {
        environment: 'staging',
        payloadIncluded: false,
        errorDetailIncluded: false,
        retryAuthorized: false,
        cancellationAuthorized: false,
        incidentControlAuthorized: false,
        executionSurface: 'SEPARATELY_GATED_AUDITED_CLI',
      },
    })
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        actorId: 'operator_1',
        action: 'JOB_TERMINAL_REDRIVE_PREVIEWED',
        targetId: 'record_1',
      }),
    )
    expect(JSON.stringify(result)).not.toContain('never return')
  })

  it('fails closed outside staging before reading evidence', async () => {
    const deps = dependencies({ environment: 'production' })
    await expect(
      previewTerminalJobRedrive({ jobRecordId: evidence.id }, 'operator_1', deps as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(deps.loadEvidence).not.toHaveBeenCalled()
  })

  it('preserves safe refusal guidance but sanitizes Redis failures', async () => {
    await expect(
      previewTerminalJobRedrive(
        { jobRecordId: evidence.id },
        'operator_1',
        dependencies({
          inspect: vi.fn().mockRejectedValue(new TerminalRedriveRefusal('Job is no longer failed')),
        }) as never,
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Job is no longer failed' })

    await expect(
      previewTerminalJobRedrive(
        { jobRecordId: evidence.id },
        'operator_1',
        dependencies({
          inspect: vi.fn().mockRejectedValue(new Error('PRIVATE_REDIS_HOST')),
        }) as never,
      ),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Live BullMQ recovery evidence could not be observed.',
    })
  })

  it('does not return evidence when the audit cannot be persisted', async () => {
    await expect(
      previewTerminalJobRedrive(
        { jobRecordId: evidence.id },
        'operator_1',
        dependencies({ audit: vi.fn().mockRejectedValue(new Error('audit unavailable')) }) as never,
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Recovery preview audit could not be persisted.',
    })
  })

  it('sanitizes persisted-evidence read failures', async () => {
    await expect(
      previewTerminalJobRedrive(
        { jobRecordId: evidence.id },
        'operator_1',
        dependencies({
          loadEvidence: vi.fn().mockRejectedValue(new Error('PRIVATE_DATABASE_HOST')),
        }) as never,
      ),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Persisted recovery evidence could not be read.',
    })
  })
})
