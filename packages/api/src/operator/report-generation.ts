import type { OPERATOR_REPORT_GENERATION_CLASSES } from '@pathfinder/contracts/operator-mcp'

export type ReportGenerationClass = (typeof OPERATOR_REPORT_GENERATION_CLASSES)[number]

export type GenerationJobEvidence = Readonly<{
  id: string
  status: 'RUNNING' | 'COMPLETE' | 'FAILED'
  failureDisposition: string | null
}>

export type ReportGenerationClassification = Readonly<{
  classification: ReportGenerationClass
  reason: string
  nextAction: string
  /** True or false when the report carries a lease; null when it never held one. */
  leaseLive: boolean | null
}>

/**
 * Classifies a report that is still GENERATING from what the worker actually left behind: the
 * report's execution lease (renewed by the worker's heartbeat), the newest job record and the
 * dispatch. Age is deliberately not an input: a report that is two months old with a live lease is
 * running, and a report that is two minutes old with a failed job has failed.
 *
 * `unknown` is a real answer. It means the evidence disagrees or is incomplete, and a person
 * should look; it must not be shown as healthy or as failed.
 */
export function classifyGeneratingReport(
  input: Readonly<{
    leaseExpiresAt: Date | null
    latestJob: GenerationJobEvidence | null
    jobCount: number
    now: Date
  }>,
): ReportGenerationClassification {
  const leaseLive =
    input.leaseExpiresAt === null ? null : input.leaseExpiresAt.getTime() > input.now.getTime()
  if (leaseLive === true) {
    return {
      classification: 'job_running_with_heartbeat',
      reason: 'The report holds an unexpired execution lease, so a worker is renewing it.',
      nextAction: 'Wait. Check again after the lease would have expired.',
      leaseLive,
    }
  }
  if (input.latestJob?.status === 'FAILED') {
    return {
      classification: 'job_failed',
      reason: `The newest job record failed (${input.latestJob.failureDisposition ?? 'no disposition recorded'}) and no worker holds the report.`,
      nextAction: 'Propose a retry with reports.propose_generate and retryOfReportId.',
      leaseLive,
    }
  }
  if (input.jobCount === 0) {
    return {
      classification: 'no_job_found',
      reason: 'No job record names this report, so no worker is known to have started it.',
      nextAction:
        'Confirm the weekly-report worker is running, then propose a retry with reports.propose_generate and retryOfReportId.',
      leaseLive,
    }
  }
  return {
    classification: 'unknown',
    reason:
      input.latestJob?.status === 'RUNNING'
        ? 'A job record says running but the report holds no live lease.'
        : 'A job record completed but the report is still GENERATING.',
    nextAction:
      'Inspect the job record and the worker logs. Do not retry until the cause is known.',
    leaseLive,
  }
}
