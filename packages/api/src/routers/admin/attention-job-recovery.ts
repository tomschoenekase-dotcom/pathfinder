import { env } from '@pathfinder/config'
import { isTerminalRedriveJobSupported } from '@pathfinder/jobs'

import { page } from './attention-pagination'

type AttentionJobRow = {
  id: string
  tenantId: string | null
  queue: string
  jobName: string
  bullJobId: string | null
  status: string
  attemptNumber: number | null
  maxAttempts: number | null
  failureDisposition: string | null
  terminalAt: Date | null
  createdAt: Date
}

export function projectAttentionJobs(
  jobs: AttentionJobRow[],
  limit: number,
  environment = env.RAILWAY_ENVIRONMENT,
) {
  const jobsPage = page(jobs, limit)
  return {
    ...jobsPage,
    items: jobsPage.items.map(({ bullJobId, ...job }) => ({
      ...job,
      terminalRedrivePreviewAvailable:
        environment === 'staging' &&
        bullJobId !== null &&
        job.failureDisposition === 'ATTEMPTS_EXHAUSTED' &&
        job.terminalAt !== null &&
        isTerminalRedriveJobSupported(job.queue, job.jobName),
    })),
  }
}
