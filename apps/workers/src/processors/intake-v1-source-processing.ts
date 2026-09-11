import {
  executeWebsiteIntakeResearch,
  type WebsiteResearchExecutionInput,
} from '@pathfinder/api/website-intake-research'
import { createWebsiteIntakeRuntimeDependencies } from '@pathfinder/api/website-intake-runtime'
import { isFeatureEnabled } from '@pathfinder/config'
import {
  claimIntakeV1WebsiteResearchDispatch,
  completeIntakeV1ProcessingDispatch,
  db,
  failIntakeV1ProcessingDispatch,
  holdIntakeV1ProcessingDispatch,
  listPendingIntakeV1WebsiteResearchDispatchIds,
  preflightIntakeV1WebsiteResearchDispatch,
  withTenantIsolationBypass,
  type LeasedIntakeV1ProcessingDispatch,
} from '@pathfinder/db'
import {
  enqueueIntakeV1SourceProcessing,
  type IntakeV1SourceProcessingJobPayload,
} from '@pathfinder/jobs'
import { z } from 'zod'

import {
  INTAKE_V1_WEBSITE_RESEARCH_POLICY,
  intakeV1WebsiteResearchActor,
} from './intake-v1-website-research-policy'

const payloadSchema = z.object({ dispatchId: z.string().trim().min(1).max(191) }).strict()

type ExactDispatch = Pick<
  LeasedIntakeV1ProcessingDispatch,
  'id' | 'tenantId' | 'venueId' | 'operationId' | 'leaseToken' | 'sourceHash'
>

type ResearchReceipt = {
  receiptId: string
  outcome: string
}

export type IntakeV1SourceProcessingDependencies = {
  claim(dispatchId: string, leaseOwner: string): Promise<LeasedIntakeV1ProcessingDispatch | null>
  preflight(
    exact: ExactDispatch & { policyVersion: string },
  ): Promise<
    | { state: 'EXECUTE'; dispatch: LeasedIntakeV1ProcessingDispatch }
    | { state: 'INHERITED'; dispatch: { status: string } }
  >
  execute(input: WebsiteResearchExecutionInput): Promise<ResearchReceipt>
  complete(exact: ExactDispatch & { receiptId: string }): Promise<{ status: string }>
  hold(
    exact: ExactDispatch & { receiptId: string; reason: 'INACCESSIBLE' | 'RESEARCH_FAILED' },
  ): Promise<{ status: string }>
  fail(exact: ExactDispatch & { error: string }): Promise<{ status: 'PENDING' | 'FAILED' }>
  listPending(limit: number): Promise<Array<{ id: string }>>
  enqueue(dispatchId: string): Promise<void>
}

export type IntakeV1SourceProcessingOptions = {
  enabled?: boolean
}

const dependencies: IntakeV1SourceProcessingDependencies = {
  claim: (dispatchId, leaseOwner) =>
    withTenantIsolationBypass(() =>
      claimIntakeV1WebsiteResearchDispatch({ dispatchId, leaseOwner }),
    ),
  preflight: (exact) =>
    withTenantIsolationBypass(() => preflightIntakeV1WebsiteResearchDispatch(exact)),
  execute: (request) =>
    withTenantIsolationBypass(() =>
      executeWebsiteIntakeResearch({
        db,
        request,
        dependencies: createWebsiteIntakeRuntimeDependencies({
          userAgent: INTAKE_V1_WEBSITE_RESEARCH_POLICY.userAgent,
        }),
      }),
    ),
  complete: (exact) => withTenantIsolationBypass(() => completeIntakeV1ProcessingDispatch(exact)),
  hold: (exact) => withTenantIsolationBypass(() => holdIntakeV1ProcessingDispatch(exact)),
  fail: (exact) => withTenantIsolationBypass(() => failIntakeV1ProcessingDispatch(exact)),
  listPending: (limit) =>
    withTenantIsolationBypass(() => listPendingIntakeV1WebsiteResearchDispatchIds({ limit })),
  enqueue: enqueueIntakeV1SourceProcessing,
}

function exact(dispatch: LeasedIntakeV1ProcessingDispatch): ExactDispatch {
  return {
    id: dispatch.id,
    tenantId: dispatch.tenantId,
    venueId: dispatch.venueId,
    operationId: dispatch.operationId,
    leaseToken: dispatch.leaseToken,
    sourceHash: dispatch.sourceHash,
  }
}

function safeError(): string {
  return 'V1 website research transport failed with an uncertain canonical receipt outcome.'
}

export async function processIntakeV1SourceProcessingJob(
  rawPayload: IntakeV1SourceProcessingJobPayload,
  workerId: string,
  injected: IntakeV1SourceProcessingDependencies = dependencies,
  options: IntakeV1SourceProcessingOptions = {},
): Promise<
  | 'completed'
  | 'held'
  | 'retry-pending'
  | 'retry-exhausted'
  | 'not-claimed'
  | 'superseded'
  | 'disabled'
> {
  if (!(options.enabled ?? isFeatureEnabled('intakeV1WebsiteResearchWorker'))) return 'disabled'
  const payload = payloadSchema.parse(rawPayload)
  const dispatch = await injected.claim(payload.dispatchId, workerId)
  if (!dispatch) return 'not-claimed'

  const dispatchExact = exact(dispatch)
  if (dispatch.policyVersion !== INTAKE_V1_WEBSITE_RESEARCH_POLICY.version) {
    const result = await injected.fail({
      ...dispatchExact,
      error: 'Unknown V1 website research policy.',
    })
    return result.status === 'FAILED' ? 'retry-exhausted' : 'retry-pending'
  }

  // This is immediately before the first network-capable service call. It
  // re-reads the canonical lease, member/source hash, scope, and policy with
  // the database clock; a stale BullMQ delivery cannot enter the runtime.
  const preflight = await injected.preflight({
    ...dispatchExact,
    policyVersion: INTAKE_V1_WEBSITE_RESEARCH_POLICY.version,
  })
  if (preflight.state === 'INHERITED') {
    if (preflight.dispatch.status === 'COMPLETED') return 'completed'
    if (preflight.dispatch.status === 'HELD') return 'held'
    throw new Error('V1 research preflight returned an unsupported terminal state.')
  }
  const active = preflight.dispatch

  let receipt: ResearchReceipt
  try {
    receipt = await injected.execute({
      operationId: active.operationId,
      tenantId: active.tenantId,
      venueId: active.venueId,
      runId: active.intakeRunId,
      maxPages: INTAKE_V1_WEBSITE_RESEARCH_POLICY.maxPages,
      maxDepth: INTAKE_V1_WEBSITE_RESEARCH_POLICY.maxDepth,
      maxBytesPerPage: INTAKE_V1_WEBSITE_RESEARCH_POLICY.maxBytesPerPage,
      maxDurationMs: INTAKE_V1_WEBSITE_RESEARCH_POLICY.maxDurationMs,
      maxCostUnits: INTAKE_V1_WEBSITE_RESEARCH_POLICY.maxCostUnits,
      userAgent: INTAKE_V1_WEBSITE_RESEARCH_POLICY.userAgent,
      createdBy: intakeV1WebsiteResearchActor(active.id),
    })
  } catch {
    // A receipt-producing service result is handled below. This error has an
    // uncertain receipt outcome, so the fixed operation ID is retried through
    // the canonical processing-attempt lifecycle; it is never described as
    // proof that no network or receipt work occurred.
    const failure = await injected.fail({ ...dispatchExact, error: safeError() })
    return failure.status === 'FAILED' ? 'retry-exhausted' : 'retry-pending'
  }
  if (receipt.outcome === 'SUCCEEDED') {
    const completed = await injected.complete({ ...dispatchExact, receiptId: receipt.receiptId })
    if (completed.status !== 'COMPLETED')
      throw new Error('V1 dispatch completion was not read back.')
    return 'completed'
  }
  if (receipt.outcome !== 'INACCESSIBLE' && receipt.outcome !== 'FAILED') {
    const failure = await injected.fail({
      ...dispatchExact,
      error: 'Website research returned an unsupported canonical receipt outcome.',
    })
    return failure.status === 'FAILED' ? 'retry-exhausted' : 'retry-pending'
  }
  const held = await injected.hold({
    ...dispatchExact,
    receiptId: receipt.receiptId,
    reason: receipt.outcome === 'INACCESSIBLE' ? 'INACCESSIBLE' : 'RESEARCH_FAILED',
  })
  if (held.status !== 'HELD') throw new Error('V1 dispatch hold was not read back.')
  return 'held'
}

export async function reconcileIntakeV1SourceProcessingJobs(
  injected: IntakeV1SourceProcessingDependencies = dependencies,
  options: IntakeV1SourceProcessingOptions = {},
): Promise<{ discovered: number }> {
  if (!(options.enabled ?? isFeatureEnabled('intakeV1WebsiteResearchWorker'))) {
    return { discovered: 0 }
  }
  const dispatches = await injected.listPending(25)
  for (const dispatch of dispatches) await injected.enqueue(dispatch.id)
  return { discovered: dispatches.length }
}
