import { executeIntakeFileExtraction } from '@pathfinder/api/intake-file-extraction'
import { isFeatureEnabled } from '@pathfinder/config'
import {
  claimIntakeV1FileExtractionDispatch,
  completeIntakeV1FileExtractionDispatch,
  db,
  failIntakeV1FileExtractionDispatch,
  listPendingIntakeV1FileExtractionDispatchIds,
  preflightIntakeV1FileExtractionDispatch,
  withTenantIsolationBypass,
  type LeasedIntakeV1FileExtractionDispatch,
} from '@pathfinder/db'
import {
  enqueueIntakeV1FileExtraction,
  type IntakeV1FileExtractionJobPayload,
} from '@pathfinder/jobs'
import { z } from 'zod'

export const INTAKE_V1_FILE_EXTRACTION_POLICY = {
  version: 'intake-v1-file-extraction-v1',
  maxAttempts: 3,
  leaseDurationMs: 120_000,
} as const

const payloadSchema = z.object({ dispatchId: z.string().trim().min(1).max(191) }).strict()

type ExactDispatch = Pick<
  LeasedIntakeV1FileExtractionDispatch,
  'id' | 'tenantId' | 'venueId' | 'operationId' | 'leaseToken' | 'sourceHash'
>

type ExtractionRequest = Omit<Parameters<typeof executeIntakeFileExtraction>[0], 'db'>
type ExtractionReceipt = Awaited<ReturnType<typeof executeIntakeFileExtraction>>

export type IntakeV1FileExtractionDependencies = {
  claim(
    dispatchId: string,
    leaseOwner: string,
  ): Promise<LeasedIntakeV1FileExtractionDispatch | null>
  preflight(
    exact: ExactDispatch & { policyVersion: typeof INTAKE_V1_FILE_EXTRACTION_POLICY.version },
  ): Promise<
    | { state: 'EXECUTE'; dispatch: LeasedIntakeV1FileExtractionDispatch }
    | { state: 'INHERITED'; dispatch: { status: string } }
  >
  execute(input: ExtractionRequest): Promise<ExtractionReceipt>
  complete(exact: ExactDispatch & { receiptId: string }): Promise<{ status: 'COMPLETED' | 'HELD' }>
  fail(
    exact: ExactDispatch & { error: string },
  ): Promise<{ status: 'PENDING' | 'FAILED' | 'COMPLETED' | 'HELD' }>
  listPending(limit: number): Promise<Array<{ id: string }>>
  enqueue(dispatchId: string): Promise<void>
}

export type IntakeV1FileExtractionOptions = { enabled?: boolean }

function failureResult(status: 'PENDING' | 'FAILED' | 'COMPLETED' | 'HELD') {
  if (status === 'COMPLETED') return 'completed' as const
  if (status === 'HELD') return 'held' as const
  return status === 'FAILED' ? ('retry-exhausted' as const) : ('retry-pending' as const)
}

const dependencies: IntakeV1FileExtractionDependencies = {
  claim: (dispatchId, leaseOwner) =>
    withTenantIsolationBypass(() =>
      claimIntakeV1FileExtractionDispatch({ dispatchId, leaseOwner }),
    ),
  preflight: (exact) =>
    withTenantIsolationBypass(() => preflightIntakeV1FileExtractionDispatch(exact)),
  execute: (request) =>
    withTenantIsolationBypass(() => executeIntakeFileExtraction({ db, ...request })),
  complete: (exact) =>
    withTenantIsolationBypass(() => completeIntakeV1FileExtractionDispatch(exact)),
  fail: (exact) => withTenantIsolationBypass(() => failIntakeV1FileExtractionDispatch(exact)),
  listPending: (limit) =>
    withTenantIsolationBypass(() => listPendingIntakeV1FileExtractionDispatchIds({ limit })),
  enqueue: enqueueIntakeV1FileExtraction,
}

function exact(dispatch: LeasedIntakeV1FileExtractionDispatch): ExactDispatch {
  return {
    id: dispatch.id,
    tenantId: dispatch.tenantId,
    venueId: dispatch.venueId,
    operationId: dispatch.operationId,
    leaseToken: dispatch.leaseToken,
    sourceHash: dispatch.sourceHash,
  }
}

export async function processIntakeV1FileExtractionJob(
  rawPayload: IntakeV1FileExtractionJobPayload,
  workerId: string,
  injected: IntakeV1FileExtractionDependencies = dependencies,
  options: IntakeV1FileExtractionOptions = {},
): Promise<
  | 'completed'
  | 'held'
  | 'retry-pending'
  | 'retry-exhausted'
  | 'not-claimed'
  | 'superseded'
  | 'disabled'
> {
  if (!(options.enabled ?? isFeatureEnabled('intakeV1FileExtractionWorker'))) return 'disabled'
  const payload = payloadSchema.parse(rawPayload)
  const dispatch = await injected.claim(payload.dispatchId, workerId)
  if (!dispatch) return 'not-claimed'

  const dispatchExact = exact(dispatch)
  if (dispatch.policyVersion !== INTAKE_V1_FILE_EXTRACTION_POLICY.version) {
    const result = await injected.fail({
      ...dispatchExact,
      error: 'Unknown V1 file extraction policy.',
    })
    return failureResult(result.status)
  }

  // This is the final authority read before the storage-capable service call.
  // Retries retain the same operation ID so an uncertain receipt is recovered.
  const preflight = await injected.preflight({
    ...dispatchExact,
    policyVersion: INTAKE_V1_FILE_EXTRACTION_POLICY.version,
  })
  if (preflight.state === 'INHERITED') {
    if (preflight.dispatch.status === 'COMPLETED') return 'completed'
    if (preflight.dispatch.status === 'HELD') return 'held'
    throw new Error('V1 file extraction preflight returned an unsupported terminal state.')
  }
  const active = preflight.dispatch

  let receipt: ExtractionReceipt
  try {
    receipt = await injected.execute({
      tenantId: active.tenantId,
      venueId: active.venueId,
      runId: active.intakeRunId,
      operationId: active.operationId,
      createdBy: `intake-v1-file:${active.id}`,
      fileDispatchLease: exact(active),
    })
  } catch {
    const failure = await injected.fail({
      ...dispatchExact,
      error: 'V1 file extraction failed with an uncertain canonical receipt outcome.',
    })
    return failureResult(failure.status)
  }

  const completed = await injected.complete({ ...dispatchExact, receiptId: receipt.receiptId })
  if (completed.status === 'COMPLETED') return 'completed'
  if (completed.status === 'HELD') return 'held'
  throw new Error('V1 file extraction completion was not read back.')
}

export async function reconcileIntakeV1FileExtractionJobs(
  injected: IntakeV1FileExtractionDependencies = dependencies,
  options: IntakeV1FileExtractionOptions = {},
): Promise<{ discovered: number }> {
  if (!(options.enabled ?? isFeatureEnabled('intakeV1FileExtractionWorker'))) {
    return { discovered: 0 }
  }
  const dispatches = await injected.listPending(25)
  for (const dispatch of dispatches) await injected.enqueue(dispatch.id)
  return { discovered: dispatches.length }
}
