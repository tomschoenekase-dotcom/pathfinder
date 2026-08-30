import { describe, expect, it, vi } from 'vitest'

const { supported } = vi.hoisted(() => ({ supported: vi.fn(() => true) }))
vi.mock('@pathfinder/config', () => ({ env: { RAILWAY_ENVIRONMENT: 'staging' } }))
vi.mock('@pathfinder/jobs', () => ({ isTerminalRedriveJobSupported: supported }))

import { projectAttentionJobs } from './attention-job-recovery'

const terminalAt = new Date('2026-08-23T12:00:00.000Z')
const row = {
  id: 'record_1',
  tenantId: 'tenant_1',
  queue: 'staging--weekly-report',
  jobName: 'weekly-report-process',
  bullJobId: 'weekly-report-report_1',
  status: 'FAILED',
  attemptNumber: 6,
  maxAttempts: 6,
  failureDisposition: 'ATTEMPTS_EXHAUSTED',
  terminalAt,
  createdAt: terminalAt,
}

describe('attention job recovery projection', () => {
  it('marks an exact staging candidate without returning its BullMQ identity', () => {
    const result = projectAttentionJobs([row], 10, 'staging')
    expect(result.items[0]).toMatchObject({ terminalRedrivePreviewAvailable: true })
    expect(result.items[0]).not.toHaveProperty('bullJobId')
  })

  it.each([
    { label: 'production environment', environment: 'production', rowChange: {} },
    { label: 'missing BullMQ identity', environment: 'staging', rowChange: { bullJobId: null } },
    {
      label: 'nonterminal disposition',
      environment: 'staging',
      rowChange: { failureDisposition: 'RETRY_ELIGIBLE' },
    },
    {
      label: 'missing terminal timestamp',
      environment: 'staging',
      rowChange: { terminalAt: null },
    },
  ] as const)('does not advertise preview for $label', ({ environment, rowChange }) => {
    const result = projectAttentionJobs([{ ...row, ...rowChange }], 10, environment)
    expect(result.items[0]?.terminalRedrivePreviewAvailable).toBe(false)
  })

  it('does not advertise a statically unsupported leaf job', () => {
    supported.mockReturnValueOnce(false)
    expect(
      projectAttentionJobs([row], 10, 'staging').items[0]?.terminalRedrivePreviewAvailable,
    ).toBe(false)
  })
})
