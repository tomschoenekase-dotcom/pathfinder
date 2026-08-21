import { createHash, timingSafeEqual } from 'node:crypto'

import type { Job, JobsOptions, Queue } from 'bullmq'

import {
  ANALYTICS_ENRICHMENT_PROCESS_JOB,
  ANALYTICS_ENRICHMENT_QUEUE,
  ANSWER_ANALYSIS_PROCESS_JOB,
  ANSWER_ANALYSIS_QUEUE,
  DAILY_ROLLUP_PROCESS_JOB,
  DAILY_ROLLUP_QUEUE,
  EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB,
  EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB,
  EMBED_KNOWLEDGE_ENTRY_QUEUE,
  EMBED_PLACE_PROCESS_JOB,
  EMBED_PLACE_QUEUE,
  MEDIA_INGESTION_PROCESS_JOB,
  MEDIA_INGESTION_QUEUE,
  SEND_EMAIL_QUEUE,
  SEND_WELCOME_EMAIL_JOB,
  WEEKLY_DIGEST_PROCESS_JOB,
  WEEKLY_DIGEST_QUEUE,
  WEEKLY_REPORT_PROCESS_JOB,
  WEEKLY_REPORT_QUEUE,
} from './queues'

const MAX_JOB_ID_LENGTH = 512
const TERMINAL_REDRIVE_CONFIRMATION_DOMAIN = 'pathfinder-terminal-redrive-v1'

const supportedQueueJobs = new Map<string, ReadonlySet<string>>([
  [WEEKLY_DIGEST_QUEUE, new Set([WEEKLY_DIGEST_PROCESS_JOB])],
  [ANSWER_ANALYSIS_QUEUE, new Set([ANSWER_ANALYSIS_PROCESS_JOB])],
  [WEEKLY_REPORT_QUEUE, new Set([WEEKLY_REPORT_PROCESS_JOB])],
  [DAILY_ROLLUP_QUEUE, new Set([DAILY_ROLLUP_PROCESS_JOB])],
  [EMBED_PLACE_QUEUE, new Set([EMBED_PLACE_PROCESS_JOB])],
  [
    EMBED_KNOWLEDGE_ENTRY_QUEUE,
    new Set([EMBED_KNOWLEDGE_ENTRY_PROCESS_JOB, EMBED_COMPANY_KNOWLEDGE_PROCESS_JOB]),
  ],
  [ANALYTICS_ENRICHMENT_QUEUE, new Set([ANALYTICS_ENRICHMENT_PROCESS_JOB])],
  [SEND_EMAIL_QUEUE, new Set([SEND_WELCOME_EMAIL_JOB])],
  [MEDIA_INGESTION_QUEUE, new Set([MEDIA_INGESTION_PROCESS_JOB])],
])

export type TerminalJobRecordEvidence = {
  id: string
  queue: string
  jobName: string
  bullJobId: string | null
  tenantId: string | null
  payload: unknown
  status: string
  attemptNumber: number | null
  maxAttempts: number | null
  failureDisposition: string | null
  terminalAt: Date | null
}

type RedriveJob = Pick<
  Job,
  'attemptsMade' | 'attemptsStarted' | 'data' | 'getState' | 'id' | 'name' | 'opts' | 'retry'
>

export type TerminalRedriveQueue = Pick<Queue, 'name'> & {
  getJob(jobId: string): Promise<RedriveJob | undefined>
}

export type TerminalRedrivePreview = {
  queueName: string
  bullJobId: string
  jobName: string
  terminalAt: string
  attemptsMade: number
  attemptsStarted: number
  maxAttempts: number
  payloadDigest: string
  confirmationToken: string
}

export class TerminalRedriveRefusal extends Error {}

function refuse(message: string): never {
  throw new TerminalRedriveRefusal(message)
}

function validateOpaqueJobId(jobId: string): void {
  const hasControlCharacter = [...jobId].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    jobId.length > MAX_JOB_ID_LENGTH ||
    hasControlCharacter
  ) {
    refuse('BullMQ job ID must be a nonempty bounded opaque identifier without control characters')
  }
}

function configuredAttempts(options: JobsOptions): number {
  const attempts = options.attempts
  if (!Number.isInteger(attempts) || (attempts ?? 0) < 1) return 1
  return attempts as number
}

function jobTenantId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || !('tenantId' in data)) return null
  const tenantId = data.tenantId
  return typeof tenantId === 'string' && tenantId.length > 0 ? tenantId : null
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object') refuse('Terminal redrive payload is not canonical JSON')
  if (ancestors.has(value)) refuse('Terminal redrive payload contains a cycle')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      refuse('Terminal redrive payload is not a plain JSON object')
    }
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function confirmationToken(params: {
  recordId: string
  queueName: string
  bullJobId: string
  jobName: string
  terminalAt: string
  attemptsMade: number
  attemptsStarted: number
  maxAttempts: number
  tenantId: string
  payloadDigest: string
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([TERMINAL_REDRIVE_CONFIRMATION_DOMAIN, params]))
    .digest('hex')
  return `terminal-redrive-${digest}`
}

function confirmationMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function supportedTerminalRedriveQueues(): string[] {
  return [...supportedQueueJobs.keys()].sort()
}

export async function inspectTerminalJobRedrive(params: {
  queue: TerminalRedriveQueue
  bullJobId: string
  evidence: TerminalJobRecordEvidence | null
}): Promise<{ preview: TerminalRedrivePreview; job: RedriveJob }> {
  validateOpaqueJobId(params.bullJobId)
  const allowedJobs = supportedQueueJobs.get(params.queue.name)
  if (!allowedJobs) refuse('Queue is not approved for terminal redrive')

  const evidence = params.evidence
  if (!evidence) refuse('No matching JobRecord evidence exists')
  if (evidence.queue !== params.queue.name || evidence.bullJobId !== params.bullJobId) {
    refuse('JobRecord identity does not match the requested queue and job')
  }
  if (!allowedJobs.has(evidence.jobName)) refuse('JobRecord job type is not approved for redrive')
  if (evidence.status !== 'FAILED' || evidence.failureDisposition !== 'ATTEMPTS_EXHAUSTED') {
    refuse('Only attempts-exhausted failed jobs may be redriven')
  }
  if (
    !evidence.terminalAt ||
    !Number.isInteger(evidence.attemptNumber) ||
    !Number.isInteger(evidence.maxAttempts) ||
    (evidence.attemptNumber ?? 0) < 1 ||
    evidence.attemptNumber !== evidence.maxAttempts
  ) {
    refuse('JobRecord terminal attempt evidence is incomplete or inconsistent')
  }

  const job = await params.queue.getJob(params.bullJobId)
  if (!job || job.id !== params.bullJobId)
    refuse('BullMQ job does not exist with the exact identity')
  if (job.name !== evidence.jobName || !allowedJobs.has(job.name)) {
    refuse('BullMQ job type does not match approved JobRecord evidence')
  }
  if ((await job.getState()) !== 'failed') refuse('BullMQ job is not currently in the failed set')

  const maxAttempts = configuredAttempts(job.opts)
  if (
    job.attemptsMade !== maxAttempts ||
    evidence.attemptNumber !== job.attemptsMade ||
    evidence.maxAttempts !== maxAttempts
  ) {
    refuse('BullMQ and JobRecord attempt evidence do not prove exhaustion')
  }
  const tenantId = jobTenantId(job.data)
  if (!evidence.tenantId || evidence.tenantId !== tenantId) {
    refuse('BullMQ and JobRecord tenant identities do not match')
  }
  const redisPayloadDigest = payloadDigest(job.data)
  if (payloadDigest(evidence.payload) !== redisPayloadDigest) {
    refuse('BullMQ and JobRecord payloads do not match')
  }
  if (!Number.isInteger(job.attemptsStarted) || job.attemptsStarted !== job.attemptsMade) {
    refuse('BullMQ started-attempt evidence does not match completed attempts')
  }

  const terminalAt = evidence.terminalAt.toISOString()
  const previewWithoutToken = {
    queueName: params.queue.name,
    bullJobId: params.bullJobId,
    jobName: job.name,
    terminalAt,
    attemptsMade: job.attemptsMade,
    attemptsStarted: job.attemptsStarted,
    maxAttempts,
    payloadDigest: redisPayloadDigest,
  }
  return {
    preview: {
      ...previewWithoutToken,
      confirmationToken: confirmationToken({
        recordId: evidence.id,
        tenantId: evidence.tenantId,
        ...previewWithoutToken,
      }),
    },
    job,
  }
}

export async function redriveTerminalJob(params: {
  queue: TerminalRedriveQueue
  bullJobId: string
  evidence: TerminalJobRecordEvidence | null
  confirmationToken: string
}): Promise<TerminalRedrivePreview> {
  const inspected = await inspectTerminalJobRedrive(params)
  if (!confirmationMatches(params.confirmationToken, inspected.preview.confirmationToken)) {
    refuse('Redrive confirmation token does not match the current terminal job evidence')
  }
  await inspected.job.retry('failed', {
    resetAttemptsMade: true,
    resetAttemptsStarted: true,
  })
  return inspected.preview
}
