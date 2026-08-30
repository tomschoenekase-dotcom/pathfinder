import { createHash, randomUUID } from 'node:crypto'

import {
  ClientVenuePackagePreview,
  ReviewableVenuePackageEvaluationPreview,
} from '@pathfinder/contracts'
import { buildVenueSystemPromptParts } from '@pathfinder/api/venue-context'
import {
  AI_MODEL_KEYS,
  generateText,
  getAiModelSpec,
  observedAiCostUnits,
  textAttemptCostCeilingUnits,
  type AiMessage,
  type AiSystemBlock,
} from '@pathfinder/ai'
import { env, logger } from '@pathfinder/config'
import {
  canonicalEvaluationJson,
  createEvalObservation,
  EvalCaseManifestSchema,
  EvalCaseSchema,
  scoreEvaluationChecks,
  type CanonicalJsonValue,
  type EvalCase,
  type EvalObservation,
  type EvalResult,
} from '@pathfinder/contracts/evaluation'
import {
  NativeCoreVisibleState,
  nativeCoreVisibleStateHash,
} from '@pathfinder/contracts/native-venue-deployment'
import {
  assertVenueAiAvailable,
  claimEvaluationRunAttempt,
  db,
  EVALUATION_RUN_EXECUTION_LEASE_MS,
  evaluationSnapshotHash,
  getEvaluationRegressionAlertPolicy,
  hashEvalCase,
  hashEvalObservation,
  failEvaluationRunAttempt,
  finishEvaluationRunAttempt,
  isEvaluationRunCancellationRequested,
  isEvaluationRuntimeDurablyEnabled,
  isVerifiedEvaluationRunIdentity,
  persistEvaluationResultWithCostReservation,
  persistEvaluationResultWithLease,
  publishOperationalEvent,
  reserveEvaluationRunCaseCost,
  renewEvaluationRunLease,
  recordApprovedPackageEvaluationMilestones,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
  type EvaluationResultTerminal,
} from '@pathfinder/db'
import {
  EVALUATION_RUN_PROCESS_JOB,
  EVALUATION_RUN_QUEUE,
  type EvaluationRunJobPayload,
} from '@pathfinder/jobs'

import { createWorkerAiBudgetGate, createWorkerAiUsageSink } from '../lib/ai-usage'
import {
  ExecutionLeaseCancelledError,
  ExecutionLeaseOwnershipLostError,
  withExecutionLeaseHeartbeat,
} from '../lib/execution-lease-heartbeat'
import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

export const EVALUATION_RUN_MAX_CASES = 50
export const EVALUATION_RUNNER_FLAG = 'evaluation-runner-v1'
const CONTENT_SNAPSHOT_HASH_DOMAIN = 'pathfinder-venue-content-snapshot-v1'

export function detectEvaluationRegression(input: {
  currentPassed: number
  currentScored: number
  previousPassed: number
  previousScored: number
  minimumDrop: number
}) {
  if (input.currentScored <= 0 || input.previousScored <= 0) return null
  const currentRate = input.currentPassed / input.currentScored
  const previousRate = input.previousPassed / input.previousScored
  const drop = Math.round((previousRate - currentRate) * 1_000_000_000_000) / 1_000_000_000_000
  if (drop < input.minimumDrop) return null
  return { currentRate, previousRate, drop }
}

async function publishEvaluationRegressionIfPresent(
  payload: EvaluationRunJobPayload,
): Promise<void> {
  await withTenantIsolationBypass(async () => {
    const policy = await getEvaluationRegressionAlertPolicy(db)
    if (!policy) return
    const current = await db.evalRun.findFirst({
      where: {
        id: payload.runId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        corpusHash: true,
        modelProvider: true,
        modelName: true,
        results: { where: { outcome: 'SCORED' }, select: { passed: true } },
      },
    })
    if (!current) return
    const previous = await db.evalRun.findFirst({
      where: {
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        corpusHash: current.corpusHash,
        status: 'COMPLETED',
        id: { not: current.id },
      },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        modelProvider: true,
        modelName: true,
        results: { where: { outcome: 'SCORED' }, select: { passed: true } },
      },
    })
    if (!previous) return
    const regression = detectEvaluationRegression({
      currentPassed: current.results.filter((result) => result.passed === true).length,
      currentScored: current.results.length,
      previousPassed: previous.results.filter((result) => result.passed === true).length,
      previousScored: previous.results.length,
      minimumDrop: policy.minimumPassRateDrop,
    })
    if (!regression) return
    const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
    await publishOperationalEvent({
      client: db,
      event: {
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        eventType: 'evaluation.regression.detected',
        sourceSubsystem: 'evaluation-runner',
        severity: regression.drop >= policy.errorPassRateDrop ? 'ERROR' : 'WARNING',
        title: 'Evaluation quality regression detected',
        summary: `Pass rate declined from ${percent(regression.previousRate)} to ${percent(regression.currentRate)} on the same evaluation corpus, exceeding the explicitly configured ${percent(policy.minimumPassRateDrop)} alert threshold.`,
        actionRequired: true,
        linkedObjectType: 'evaluation-run',
        linkedObjectId: current.id,
        recommendedAction: `Compare ${previous.modelProvider}/${previous.modelName} with ${current.modelProvider}/${current.modelName} and inspect failed cases before changing routing.`,
        deduplicationKey: `evaluation-regression:${current.id}`,
      },
    })
  })
}

export type FrozenEvaluationRun = {
  id: string
  tenantId: string
  venueId: string
  identityHash: string
  caseManifestSnapshot: unknown
  promptContractVersion: string
  promptContractHash: string
  packageSnapshotRef?: string | null
  packageSnapshotHash?: string | null
  contentSnapshotKind?:
    | 'LEGACY_VENUE_CONTENT_V1'
    | 'NATIVE_CORE_V1'
    | 'APPROVED_VENUE_PACKAGE_V1'
    | 'REVIEWABLE_VENUE_PACKAGE_V1'
  contentSnapshotRef?: string | null
  contentSnapshotVersion: bigint
  contentSnapshotHash: string
  modelProvider: string
  modelName: string
  modelSnapshotHash: string
  modelSnapshot: unknown
  runConfigSnapshot: unknown
  declaredBudgetCeilingE8Usd: bigint
}

export type FrozenEvaluationCase = {
  id: string
  revision: number
  caseHash: string
  caseSnapshot: unknown
}

export type EvaluationAttempt = {
  answer: string
  latencyMs: number
  costE8Usd: bigint
  modelProvider: string
  modelName: string
}

export type EvaluationTerminalEvidence =
  | {
      outcome: 'SCORED'
      observation: EvalObservation
      result: EvalResult
      latencyMs: number
      costE8Usd: bigint
    }
  | {
      outcome: 'OPERATIONAL_FAILURE' | 'BUDGET_BLOCKED' | 'CANCELLED'
      errorCode: string
      latencyMs: number
      costE8Usd: bigint
    }

export type EvaluationRunnerDependencies = {
  loadRun(payload: EvaluationRunJobPayload): Promise<FrozenEvaluationRun | null>
  loadCases(params: {
    tenantId: string
    venueId: string
    manifest: { caseId: string; revision: number; caseHash: string }[]
  }): Promise<FrozenEvaluationCase[]>
  loadExistingResults(params: { runId: string; tenantId: string; venueId: string }): Promise<
    {
      caseId: string
      caseRevision: number
      caseHash: string
      costE8Usd: bigint
    }[]
  >
  evaluate(params: {
    run: FrozenEvaluationRun
    evalCase: EvalCase
    contentSnapshot: CanonicalJsonValue
    remainingBudgetE8Usd: bigint
    leaseToken: string
  }): Promise<EvaluationAttempt>
  renewLease(params: { run: FrozenEvaluationRun; leaseToken: string }): Promise<boolean>
  reserve(params: {
    run: FrozenEvaluationRun
    evalCase: FrozenEvaluationCase
    attemptNumber: number
    leaseToken: string
    reservedCostE8Usd: bigint
  }): Promise<
    | { state: 'reserved'; reservationId: string }
    | { state: 'ambiguous'; reservationId: string }
    | { state: 'budget-blocked' }
  >
  persist(params: {
    run: FrozenEvaluationRun
    evalCase: FrozenEvaluationCase
    attemptNumber: number
    leaseToken: string
    terminal: EvaluationTerminalEvidence
    reservation?: { id: string; settlement: 'exact' | 'ambiguous' }
  }): Promise<void>
  isCancelled(runId: string): Promise<boolean>
  isCancellationRequested(runId: string): Promise<boolean>
}

class EvaluationDeclaredBudgetError extends Error {
  constructor() {
    super('Evaluation request exceeds the frozen run budget')
    this.name = 'EvaluationDeclaredBudgetError'
  }
}

export async function assertFinalEvaluationProviderAdmission(checks: {
  signalAborted: boolean
  globalEnabled(): Promise<boolean>
  renewLease(): Promise<boolean>
  venueAvailable(): Promise<void>
  tenantEnabled(): Promise<boolean>
  cancellationRequested(): Promise<boolean>
}): Promise<void> {
  if (checks.signalAborted) throw new ExecutionLeaseCancelledError('EVALUATION_RUN_CANCELLED')
  if (!(await checks.globalEnabled())) throw new Error('EVALUATION_RUNTIME_DISABLED')
  if (!(await checks.renewLease())) {
    throw new ExecutionLeaseOwnershipLostError('EVALUATION_RUN_LEASE_LOST')
  }
  await checks.venueAvailable()
  if (!(await checks.tenantEnabled())) {
    throw new ExecutionLeaseCancelledError('EVALUATION_RUN_CANCELLED')
  }
  // This is deliberately last: cancellation may commit after the case boundary
  // and reservation CAS but before the provider facade performs I/O.
  if (await checks.cancellationRequested()) {
    throw new ExecutionLeaseCancelledError('EVALUATION_RUN_CANCELLED')
  }
}

function resultFor(evalCase: EvalCase, observation: EvalObservation, caseHash: string): EvalResult {
  const checks = scoreEvaluationChecks(evalCase, observation)
  const passedChecks = checks.filter((check) => check.passed).length
  return {
    schemaVersion: evalCase.schemaVersion,
    caseId: evalCase.caseId,
    caseHash,
    observationHash: hashEvalObservation(observation),
    passed: passedChecks === checks.length,
    score: passedChecks / checks.length,
    checks,
  }
}

export function frozenContent(run: FrozenEvaluationRun): CanonicalJsonValue {
  if (typeof run.runConfigSnapshot !== 'object' || run.runConfigSnapshot === null) {
    throw new Error('EVALUATION_RUN_CONFIG_INVALID')
  }
  const config = run.runConfigSnapshot as Record<string, unknown>
  if (run.contentSnapshotKind === 'REVIEWABLE_VENUE_PACKAGE_V1') {
    if (
      config.version !== 'pathfinder-reviewable-package-evaluation-run-config-v1' ||
      config.contentSnapshot === undefined
    )
      throw new Error('EVALUATION_CONTENT_SNAPSHOT_MISSING')
    const content = config.contentSnapshot as Record<string, unknown>
    const preview = ReviewableVenuePackageEvaluationPreview.safeParse(content.preview)
    if (
      content.version !== 'pathfinder-reviewable-package-evaluation-content-v1' ||
      content.tenantId !== run.tenantId ||
      content.venueId !== run.venueId ||
      content.packageId !== run.contentSnapshotRef ||
      content.payloadHash !== run.packageSnapshotHash ||
      typeof content.baseDigest !== 'string' ||
      !preview.success ||
      preview.data.venue.id !== run.venueId ||
      preview.data.package.id !== run.contentSnapshotRef ||
      preview.data.package.status !== content.packageStatus ||
      evaluationSnapshotHash(
        'pathfinder-reviewable-package-evaluation-content-v1',
        content as never,
      ) !== run.contentSnapshotHash
    )
      throw new Error('EVALUATION_CONTENT_IDENTITY_MISMATCH')
    return content as CanonicalJsonValue
  }
  if (run.contentSnapshotKind === 'APPROVED_VENUE_PACKAGE_V1') {
    if (
      config.version !== 'pathfinder-approved-package-evaluation-run-config-v1' ||
      config.contentSnapshot === undefined
    )
      throw new Error('EVALUATION_CONTENT_SNAPSHOT_MISSING')
    const content = config.contentSnapshot as Record<string, unknown>
    const preview = ClientVenuePackagePreview.safeParse(content.preview)
    if (
      content.version !== 'pathfinder-approved-package-evaluation-content-v1' ||
      content.tenantId !== run.tenantId ||
      content.venueId !== run.venueId ||
      content.packageId !== run.contentSnapshotRef ||
      !preview.success ||
      preview.data.venue.id !== run.venueId ||
      preview.data.package.id !== run.contentSnapshotRef ||
      evaluationSnapshotHash('pathfinder-approved-client-package-preview-v1', content as never) !==
        run.contentSnapshotHash
    )
      throw new Error('EVALUATION_CONTENT_IDENTITY_MISMATCH')
    return content as CanonicalJsonValue
  }
  if (run.contentSnapshotKind === 'NATIVE_CORE_V1') {
    if (
      config.version !== 'pathfinder-native-evaluation-run-config-v1' ||
      config.contentSnapshot === undefined
    )
      throw new Error('EVALUATION_CONTENT_SNAPSHOT_MISSING')
    const content = config.contentSnapshot as Record<string, unknown>
    const state = NativeCoreVisibleState.safeParse(content.state)
    if (
      content.version !== 'pathfinder-native-evaluation-content-v1' ||
      content.tenantId !== run.tenantId ||
      content.venueId !== run.venueId ||
      content.releaseId !== run.contentSnapshotRef ||
      !state.success ||
      nativeCoreVisibleStateHash(state.data) !== run.contentSnapshotHash
    )
      throw new Error('EVALUATION_CONTENT_IDENTITY_MISMATCH')
    return content as CanonicalJsonValue
  }
  if (
    config.version !== 'pathfinder-evaluation-run-config-v1' ||
    config.contentSnapshot === undefined
  ) {
    throw new Error('EVALUATION_CONTENT_SNAPSHOT_MISSING')
  }
  const content = config.contentSnapshot as CanonicalJsonValue
  const hash = createHash('sha256')
    .update(`${CONTENT_SNAPSHOT_HASH_DOMAIN}\n${canonicalEvaluationJson(content)}`, 'utf8')
    .digest('hex')
  if (hash !== run.contentSnapshotHash) throw new Error('EVALUATION_CONTENT_IDENTITY_MISMATCH')
  const manifest = content as Record<string, CanonicalJsonValue>
  if (
    manifest.tenantId !== run.tenantId ||
    manifest.venueId !== run.venueId ||
    typeof manifest.promptIdentity !== 'object' ||
    manifest.promptIdentity === null ||
    (manifest.promptIdentity as Record<string, CanonicalJsonValue>).version !==
      run.promptContractVersion ||
    (manifest.promptIdentity as Record<string, CanonicalJsonValue>).hash !== run.promptContractHash
  ) {
    throw new Error('EVALUATION_CONTENT_SCOPE_MISMATCH')
  }
  return content
}

const EVALUATION_MODEL_KEYS = [AI_MODEL_KEYS.GUEST_CHAT, AI_MODEL_KEYS.GUEST_CHAT_OPENAI] as const
type EvaluationModelKey = (typeof EVALUATION_MODEL_KEYS)[number]

export function frozenEvaluationModelKey(run: FrozenEvaluationRun): EvaluationModelKey {
  const snapshotHash = evaluationSnapshotHash(
    'pathfinder-eval-model-snapshot-v1',
    run.modelSnapshot as never,
  )
  if (snapshotHash !== run.modelSnapshotHash) throw new Error('EVALUATION_MODEL_IDENTITY_MISMATCH')

  for (const modelKey of EVALUATION_MODEL_KEYS) {
    const active = getAiModelSpec(modelKey)
    if (
      active.provider === run.modelProvider &&
      active.model === run.modelName &&
      canonicalEvaluationJson(active as unknown as CanonicalJsonValue) ===
        canonicalEvaluationJson(run.modelSnapshot as CanonicalJsonValue)
    ) {
      return modelKey
    }
  }

  // The provider facade can select only the two explicitly governed guest-chat
  // candidates. Refuse an old, changed, or unrelated registry model instead of
  // silently dispatching a different provider.
  throw new Error('EVALUATION_MODEL_IDENTITY_MISMATCH')
}

/** Pure orchestration seam. Queue/DB/provider adapters remain injectable so tests
 * cannot contact Redis, Postgres, or a model provider. */
export async function executeFrozenEvaluationRun(
  payload: EvaluationRunJobPayload,
  deps: EvaluationRunnerDependencies,
  options: { finalAttempt: boolean; attemptNumber?: number; leaseToken?: string },
): Promise<{ processed: number; costE8Usd: bigint; cancelled: number }> {
  const run = await deps.loadRun(payload)
  if (
    !run ||
    run.tenantId !== payload.tenantId ||
    run.venueId !== payload.venueId ||
    run.identityHash !== payload.runIdentityHash
  ) {
    throw new Error('EVALUATION_RUN_IDENTITY_MISMATCH')
  }
  const modelKey = frozenEvaluationModelKey(run)
  const contentSnapshot = frozenContent(run)
  const manifest = EvalCaseManifestSchema.parse(run.caseManifestSnapshot)
  if (manifest.length > EVALUATION_RUN_MAX_CASES) throw new Error('EVALUATION_CASE_LIMIT_EXCEEDED')
  const [cases, existingResults] = await Promise.all([
    deps.loadCases({ tenantId: run.tenantId, venueId: run.venueId, manifest }),
    deps.loadExistingResults({ runId: run.id, tenantId: run.tenantId, venueId: run.venueId }),
  ])
  const byIdentity = new Map(
    cases.map((item) => [`${item.id}:${item.revision}:${item.caseHash}`, item]),
  )
  const manifestIdentities = new Set(
    manifest.map((item) => `${item.caseId}:${item.revision}:${item.caseHash}`),
  )
  const completedIdentities = new Set<string>()
  let spent = 0n
  for (const result of existingResults) {
    const identity = `${result.caseId}:${result.caseRevision}:${result.caseHash}`
    if (
      !manifestIdentities.has(identity) ||
      completedIdentities.has(identity) ||
      result.costE8Usd < 0n
    ) {
      throw new Error('EVALUATION_EXISTING_RESULT_IDENTITY_MISMATCH')
    }
    completedIdentities.add(identity)
    spent += result.costE8Usd
  }
  if (spent > run.declaredBudgetCeilingE8Usd) {
    throw new Error('EVALUATION_EXISTING_COST_EXCEEDS_BUDGET')
  }
  let processed = existingResults.length
  let cancelled = 0
  const executionFence = {
    attemptNumber: options.attemptNumber ?? 1,
    leaseToken: options.leaseToken ?? '00000000-0000-4000-8000-000000000000',
  }

  for (const entry of manifest) {
    const identity = `${entry.caseId}:${entry.revision}:${entry.caseHash}`
    if (completedIdentities.has(identity)) continue
    const frozenCase = byIdentity.get(identity)
    if (!frozenCase) throw new Error('EVALUATION_CASE_IDENTITY_MISMATCH')
    const evalCase = EvalCaseSchema.parse(frozenCase.caseSnapshot)
    if (hashEvalCase(evalCase) !== frozenCase.caseHash) {
      throw new Error('EVALUATION_CASE_SNAPSHOT_HASH_MISMATCH')
    }
    const leaseToken = options.leaseToken ?? '00000000-0000-4000-8000-000000000000'
    if (!(await deps.renewLease({ run, leaseToken }))) {
      if (await deps.isCancellationRequested(run.id)) {
        throw new ExecutionLeaseCancelledError('EVALUATION_RUN_CANCELLED')
      }
      throw new ExecutionLeaseOwnershipLostError('EVALUATION_RUN_LEASE_LOST')
    }
    if (await deps.isCancelled(run.id)) {
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: { outcome: 'CANCELLED', errorCode: 'RUN_CANCELLED', latencyMs: 0, costE8Usd: 0n },
      })
      processed += 1
      cancelled += 1
      continue
    }
    if (spent >= run.declaredBudgetCeilingE8Usd) {
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: {
          outcome: 'BUDGET_BLOCKED',
          errorCode: 'RUN_BUDGET_CEILING',
          latencyMs: 0,
          costE8Usd: 0n,
        },
      })
      processed += 1
      continue
    }
    const reservedCostE8Usd = evaluationPromptCostCeiling(evalCase, contentSnapshot, modelKey)
    const reservation = await deps.reserve({
      run,
      evalCase: frozenCase,
      attemptNumber: options.attemptNumber ?? 1,
      leaseToken: options.leaseToken ?? '00000000-0000-4000-8000-000000000000',
      reservedCostE8Usd,
    })
    if (reservation.state === 'budget-blocked') {
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: {
          outcome: 'BUDGET_BLOCKED',
          errorCode: 'RUN_BUDGET_CEILING',
          latencyMs: 0,
          costE8Usd: 0n,
        },
      })
      processed += 1
      continue
    }
    if (reservation.state === 'ambiguous') {
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: {
          outcome: 'OPERATIONAL_FAILURE',
          errorCode: 'PROVIDER_OUTCOME_AMBIGUOUS',
          latencyMs: 0,
          costE8Usd: 0n,
        },
        reservation: { id: reservation.reservationId, settlement: 'ambiguous' },
      })
      processed += 1
      continue
    }
    try {
      const attempt = await deps.evaluate({
        run,
        evalCase,
        contentSnapshot,
        remainingBudgetE8Usd: run.declaredBudgetCeilingE8Usd - spent,
        leaseToken,
      })
      if (attempt.modelProvider !== run.modelProvider || attempt.modelName !== run.modelName) {
        throw new Error('EVALUATION_MODEL_IDENTITY_MISMATCH')
      }
      if (attempt.costE8Usd < 0n || spent + attempt.costE8Usd > run.declaredBudgetCeilingE8Usd) {
        throw new EvaluationDeclaredBudgetError()
      }
      spent += attempt.costE8Usd
      const observation = createEvalObservation({ caseId: evalCase.caseId, answer: attempt.answer })
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: {
          outcome: 'SCORED',
          observation,
          result: resultFor(evalCase, observation, frozenCase.caseHash),
          latencyMs: attempt.latencyMs,
          costE8Usd: attempt.costE8Usd,
        },
        reservation: { id: reservation.reservationId, settlement: 'exact' },
      })
      processed += 1
    } catch (error) {
      if (
        error instanceof ExecutionLeaseOwnershipLostError ||
        error instanceof ExecutionLeaseCancelledError
      ) {
        throw error
      }
      if (error instanceof EvaluationDeclaredBudgetError) {
        await deps.persist({
          run,
          evalCase: frozenCase,
          ...executionFence,
          terminal: {
            outcome: 'OPERATIONAL_FAILURE',
            errorCode: 'PROVIDER_COST_INVARIANT',
            latencyMs: 0,
            costE8Usd: 0n,
          },
          reservation: { id: reservation.reservationId, settlement: 'ambiguous' },
        })
        processed += 1
        continue
      }
      await deps.persist({
        run,
        evalCase: frozenCase,
        ...executionFence,
        terminal: {
          outcome: 'OPERATIONAL_FAILURE',
          errorCode: 'PROVIDER_OUTCOME_AMBIGUOUS',
          latencyMs: 0,
          costE8Usd: 0n,
        },
        reservation: { id: reservation.reservationId, settlement: 'ambiguous' },
      })
      processed += 1
    }
  }
  return { processed, costE8Usd: spent, cancelled }
}

type VenuePromptParams = Parameters<typeof buildVenueSystemPromptParts>[0]

function asRecord(value: CanonicalJsonValue | undefined): Record<string, CanonicalJsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, CanonicalJsonValue>)
    : {}
}

function asRecords(value: CanonicalJsonValue | undefined): Record<string, CanonicalJsonValue>[] {
  return Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
        .map((item) => item as Record<string, CanonicalJsonValue>)
    : []
}

function optionalString(value: CanonicalJsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function legacyPublishedContent(
  value: CanonicalJsonValue | undefined,
): NonNullable<VenuePromptParams['publishedUniversalContent']> {
  return asRecords(value).flatMap((revision) => {
    const kind = revision.kind
    const payloadKey =
      kind === 'SERVICE'
        ? 'service'
        : kind === 'POLICY'
          ? 'policy'
          : kind === 'EVENT'
            ? 'event'
            : kind === 'OPERATIONAL_FACT'
              ? 'operationalFact'
              : kind === 'RELATIONSHIP'
                ? 'relationship'
                : null
    if (!payloadKey || typeof revision.moduleId !== 'string') return []
    return [
      {
        moduleId: revision.moduleId,
        kind,
        payload: asRecord(revision[payloadKey]),
      } as NonNullable<VenuePromptParams['publishedUniversalContent']>[number],
    ]
  })
}

function frozenVenuePromptParams(
  content: CanonicalJsonValue,
  guideMode: EvalCase['venue']['guideMode'],
): VenuePromptParams {
  const root = asRecord(content)
  const preview = asRecord(root.preview)
  if (Object.keys(preview).length > 0) {
    const venue = asRecord(preview.venue)
    const guide = asRecord(venue.guide)
    const tone = asRecord(guide.tone)
    const experience = asRecord(preview.experience)
    return {
      venue: {
        name: String(venue.name),
        description: optionalString(venue.description),
        category: optionalString(venue.category),
        aiGuideName: optionalString(guide.name),
        tonePreset: optionalString(tone.preset),
        tonePresetVersion: typeof tone.behaviorVersion === 'number' ? tone.behaviorVersion : null,
        guideMode,
      },
      relevantPlaces: asRecords(
        experience.places,
      ) as unknown as VenuePromptParams['relevantPlaces'],
      knowledgeEntries: asRecords(experience.knowledgeEntries) as unknown as NonNullable<
        VenuePromptParams['knowledgeEntries']
      >,
      userLat: null,
      userLng: null,
      guideMode,
    }
  }

  const nativeState = asRecord(root.state)
  if (Object.keys(nativeState).length > 0) {
    const venue = asRecord(nativeState.venue)
    const configuration = asRecord(nativeState.venueBotConfiguration)
    const generalizedModules = asRecords(nativeState.generalizedModules)
    return {
      venue: {
        ...(venue as unknown as VenuePromptParams['venue']),
        tonePreset: optionalString(configuration.tonePreset) ?? optionalString(venue.tonePreset),
        tonePresetVersion:
          typeof configuration.tonePresetVersion === 'number'
            ? configuration.tonePresetVersion
            : typeof venue.tonePresetVersion === 'number'
              ? venue.tonePresetVersion
              : null,
        responseDepth:
          configuration.responseDepth === 'BRIEF' ||
          configuration.responseDepth === 'BALANCED' ||
          configuration.responseDepth === 'DETAILED'
            ? configuration.responseDepth
            : null,
      },
      relevantPlaces: asRecords(
        nativeState.places,
      ) as unknown as VenuePromptParams['relevantPlaces'],
      knowledgeEntries: asRecords(nativeState.knowledgeEntries) as unknown as NonNullable<
        VenuePromptParams['knowledgeEntries']
      >,
      publishedUniversalContent: generalizedModules.map((module) => ({
        moduleId: String(module.moduleId),
        kind: module.kind as NonNullable<
          VenuePromptParams['publishedUniversalContent']
        >[number]['kind'],
        payload: asRecord(module.payload),
      })),
      userLat: null,
      userLng: null,
      guideMode,
    }
  }

  const venue = asRecord(root.venue)
  const places = asRecords(root.places)
  const placeNames = new Map(places.map((place) => [String(place.id), String(place.name)]))
  return {
    venue: venue as unknown as VenuePromptParams['venue'],
    relevantPlaces: places as unknown as VenuePromptParams['relevantPlaces'],
    knowledgeEntries: asRecords(root.knowledgeEntries) as unknown as NonNullable<
      VenuePromptParams['knowledgeEntries']
    >,
    activeUpdates: asRecords(root.operationalUpdates).map((update) => ({
      updateType: String(update.updateType),
      severity: String(update.severity),
      priority: String(update.priority),
      title: String(update.title),
      body: optionalString(update.body),
      redirectTo: optionalString(update.redirectTo),
      place:
        typeof update.placeId === 'string' && placeNames.has(update.placeId)
          ? { name: placeNames.get(update.placeId)! }
          : null,
    })),
    publishedUniversalContent: legacyPublishedContent(root.universalRevisions),
    userLat: null,
    userLng: null,
    guideMode,
  }
}

export function evaluationPrompt(
  evalCase: EvalCase,
  content: CanonicalJsonValue,
): { system: AiSystemBlock[]; messages: AiMessage[] } {
  const prompt = buildVenueSystemPromptParts(
    frozenVenuePromptParams(content, evalCase.venue.guideMode),
  )
  return {
    system: [
      { type: 'text', text: prompt.staticPart, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt.dynamicPart },
    ],
    messages: evalCase.turns.map((turn) => ({ role: turn.role, content: turn.content })),
  }
}

export function evaluationPromptCostCeiling(
  evalCase: EvalCase,
  content: CanonicalJsonValue,
  modelKey: EvaluationModelKey = AI_MODEL_KEYS.GUEST_CHAT,
): bigint {
  const spec = getAiModelSpec(modelKey)
  if (
    new TextEncoder().encode(canonicalEvaluationJson(content)).byteLength > spec.maxInputUtf8Bytes
  ) {
    throw new Error('AI text input exceeds configured input boundary')
  }
  return textAttemptCostCeilingUnits({
    spec,
    ...evaluationPrompt(evalCase, content),
    maxOutputTokens: spec.maxOutputTokens,
  })
}

function defaultDependencies(
  payload: EvaluationRunJobPayload,
  signal?: AbortSignal,
): EvaluationRunnerDependencies {
  return {
    loadRun: (payload) =>
      withTenantIsolationBypass(async () => {
        const run = await db.evalRun.findFirst({
          where: {
            id: payload.runId,
            tenantId: payload.tenantId,
            venueId: payload.venueId,
            identityHash: payload.runIdentityHash,
          },
        })
        return run && isVerifiedEvaluationRunIdentity(run) ? run : null
      }),
    loadCases: ({ tenantId, venueId, manifest }) =>
      withTenantIsolationBypass(() =>
        db.evalCase.findMany({
          where: {
            tenantId,
            venueId,
            OR: manifest.map((item) => ({
              id: item.caseId,
              revision: item.revision,
              caseHash: item.caseHash,
            })),
          },
          select: { id: true, revision: true, caseHash: true, caseSnapshot: true },
        }),
      ),
    loadExistingResults: ({ runId, tenantId, venueId }) =>
      withTenantIsolationBypass(() =>
        db.evalResult.findMany({
          where: { runId, tenantId, venueId },
          select: {
            caseId: true,
            caseRevision: true,
            caseHash: true,
            costE8Usd: true,
          },
        }),
      ),
    isCancelled: async () => {
      if (signal?.aborted || !env.EVALUATION_RUNNER_ENABLED) return true
      if (!(await isEvaluationRuntimeDurablyEnabled(db))) return true
      if (
        await isEvaluationRunCancellationRequested({
          runId: payload.runId,
          tenantId: payload.tenantId,
          venueId: payload.venueId,
          runIdentityHash: payload.runIdentityHash,
        })
      ) {
        return true
      }
      const flag = await withTenantIsolationBypass(() =>
        db.tenantFeatureFlag.findUnique({
          where: {
            tenantId_flagKey: { tenantId: payload.tenantId, flagKey: EVALUATION_RUNNER_FLAG },
          },
          select: { enabled: true },
        }),
      )
      return flag?.enabled !== true
    },
    isCancellationRequested: () =>
      isEvaluationRunCancellationRequested({
        runId: payload.runId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        runIdentityHash: payload.runIdentityHash,
      }),
    renewLease: ({ run, leaseToken }) =>
      renewEvaluationRunLease({
        runId: run.id,
        tenantId: run.tenantId,
        venueId: run.venueId,
        runIdentityHash: run.identityHash,
        leaseToken,
      }),
    evaluate: async ({ run, evalCase, contentSnapshot, remainingBudgetE8Usd, leaseToken }) => {
      const modelKey = frozenEvaluationModelKey(run)
      const prompt = evaluationPrompt(evalCase, contentSnapshot)
      const reserved = evaluationPromptCostCeiling(evalCase, contentSnapshot, modelKey)
      if (reserved > remainingBudgetE8Usd) throw new EvaluationDeclaredBudgetError()
      const renewLease = () =>
        renewEvaluationRunLease({
          runId: run.id,
          tenantId: run.tenantId,
          venueId: run.venueId,
          runIdentityHash: run.identityHash,
          leaseToken,
        })
      const response = await withExecutionLeaseHeartbeat({
        intervalMs: Math.floor(EVALUATION_RUN_EXECUTION_LEASE_MS / 3),
        renew: renewLease,
        ...(signal ? { signal } : {}),
        leaseLostError: async () =>
          (await isEvaluationRunCancellationRequested({
            runId: run.id,
            tenantId: run.tenantId,
            venueId: run.venueId,
            runIdentityHash: run.identityHash,
          }))
            ? new ExecutionLeaseCancelledError('EVALUATION_RUN_CANCELLED')
            : new ExecutionLeaseOwnershipLostError('EVALUATION_RUN_LEASE_LOST'),
        operation: (providerSignal) =>
          generateText({
            signal: providerSignal,
            modelKey,
            ...prompt,
            maxAttempts: 1,
            usageSink: createWorkerAiUsageSink({
              tenantId: run.tenantId,
              venueId: run.venueId,
              feature: 'evaluation-run',
            }),
            admissionGuard: async () => {
              await assertFinalEvaluationProviderAdmission({
                signalAborted: providerSignal.aborted,
                globalEnabled: () => isEvaluationRuntimeDurablyEnabled(db),
                renewLease,
                venueAvailable: () =>
                  assertVenueAiAvailable(db, { tenantId: run.tenantId, venueId: run.venueId }),
                tenantEnabled: () =>
                  withTenantIsolationBypass(() =>
                    db.tenantFeatureFlag.findUnique({
                      where: {
                        tenantId_flagKey: {
                          tenantId: run.tenantId,
                          flagKey: EVALUATION_RUNNER_FLAG,
                        },
                      },
                      select: { enabled: true },
                    }),
                  ).then((flag) => flag?.enabled === true),
                cancellationRequested: () =>
                  isEvaluationRunCancellationRequested({
                    runId: run.id,
                    tenantId: run.tenantId,
                    venueId: run.venueId,
                    runIdentityHash: run.identityHash,
                  }),
              })
            },
            budgetGate: createWorkerAiBudgetGate({
              tenantId: run.tenantId,
              venueId: run.venueId,
              feature: 'evaluation-run',
            }),
          }),
      })
      return {
        answer: response.text,
        latencyMs: response.latencyMs,
        costE8Usd: observedAiCostUnits(response.estimatedCostUsd),
        modelProvider: response.provider,
        modelName: response.model,
      }
    },
    reserve: ({ run, evalCase, attemptNumber, leaseToken, reservedCostE8Usd }) =>
      withTenantIsolationBypass(async () => {
        const acquired = await reserveEvaluationRunCaseCost({
          db,
          tenantId: run.tenantId,
          venueId: run.venueId,
          runId: run.id,
          runIdentityHash: run.identityHash,
          caseId: evalCase.id,
          caseRevision: evalCase.revision,
          caseHash: evalCase.caseHash,
          attemptNumber,
          leaseToken,
          reservedCostE8Usd,
        })
        return acquired.state === 'budget-blocked'
          ? acquired
          : { state: acquired.state, reservationId: acquired.reservation.id }
      }),
    persist: ({ run, evalCase, terminal, reservation, attemptNumber, leaseToken }) =>
      withTenantIsolationBypass(async () => {
        const terminalEvidence: EvaluationResultTerminal =
          terminal.outcome === 'SCORED'
            ? { outcome: 'SCORED', observation: terminal.observation, result: terminal.result }
            : { outcome: terminal.outcome, errorCode: terminal.errorCode }
        const common = {
          db,
          resultId: randomUUID(),
          tenantId: run.tenantId,
          venueId: run.venueId,
          runId: run.id,
          runIdentityHash: run.identityHash,
          evalCaseId: evalCase.id,
          caseRevision: evalCase.revision,
          latencyMs: terminal.latencyMs,
          costE8Usd: terminal.costE8Usd,
          terminal: terminalEvidence,
        }
        if (reservation) {
          await persistEvaluationResultWithCostReservation({
            ...common,
            reservationId: reservation.id,
            settlement: reservation.settlement,
            attemptNumber,
            leaseToken,
          })
        } else {
          await persistEvaluationResultWithLease({ ...common, attemptNumber, leaseToken })
        }
      }),
  }
}

export async function processEvaluationRunJob(
  payload: EvaluationRunJobPayload,
  executionInput?: JobExecutionInput,
  signal?: AbortSignal,
  dependencies?: EvaluationRunnerDependencies,
): Promise<void> {
  const reconcileOnboardingMilestones = () =>
    withTenantIsolationBypass(() => recordApprovedPackageEvaluationMilestones(payload))
  const execution = normalizeJobExecutionMetadata(executionInput)
  const jobRecordId = await writeJobRecord({
    queue: EVALUATION_RUN_QUEUE,
    jobName: EVALUATION_RUN_PROCESS_JOB,
    bullJobId: execution.bullJobId ?? null,
    tenantId: payload.tenantId,
    status: 'RUNNING',
    payload,
    startedAt: new Date(),
    attemptNumber: execution.attemptNumber,
    maxAttempts: execution.maxAttempts,
  })
  let acquiredClaim: Extract<
    Awaited<ReturnType<typeof claimEvaluationRunAttempt>>,
    { state: 'acquired' }
  > | null = null
  try {
    const claim = await claimEvaluationRunAttempt({
      runId: payload.runId,
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      runIdentityHash: payload.runIdentityHash,
      attemptNumber: execution.attemptNumber,
      maxAttempts: execution.maxAttempts,
    })
    if (claim.state === 'not-found') throw new Error('EVALUATION_RUN_IDENTITY_MISMATCH')
    if (claim.state === 'not-admitted') throw new Error('EVALUATION_RUN_NOT_ADMITTED')
    if (claim.state !== 'acquired') {
      if (claim.state === 'terminal') await reconcileOnboardingMilestones()
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
      return
    }
    acquiredClaim = claim
    const result = await executeFrozenEvaluationRun(
      payload,
      dependencies ?? defaultDependencies(payload, signal),
      {
        finalAttempt: claim.attemptNumber >= execution.maxAttempts,
        attemptNumber: claim.attemptNumber,
        leaseToken: claim.leaseToken,
      },
    )
    const advanced = await finishEvaluationRunAttempt({
      runId: payload.runId,
      tenantId: payload.tenantId,
      venueId: payload.venueId,
      runIdentityHash: payload.runIdentityHash,
      attemptNumber: claim.attemptNumber,
      leaseToken: claim.leaseToken,
      outcome: result.cancelled > 0 ? 'CANCELLED' : 'COMPLETED',
    })
    if (!advanced) throw new Error('EVALUATION_RUN_LIFECYCLE_STALE')
    await reconcileOnboardingMilestones()
    await publishEvaluationRegressionIfPresent(payload).catch((error: unknown) => {
      logger.warn({
        action: 'evaluation.regression-event-failed',
        runId: payload.runId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
    })
    await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
  } catch (error) {
    if (acquiredClaim && error instanceof ExecutionLeaseCancelledError) {
      const cancelled = await finishEvaluationRunAttempt({
        runId: payload.runId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        runIdentityHash: payload.runIdentityHash,
        attemptNumber: acquiredClaim.attemptNumber,
        leaseToken: acquiredClaim.leaseToken,
        outcome: 'CANCELLED',
      })
      if (cancelled) {
        await reconcileOnboardingMilestones()
        await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
        return
      }
    }
    if (error instanceof ExecutionLeaseOwnershipLostError) {
      await recordJobFailure({
        jobRecordId,
        error,
        errorMessage: error.message,
        execution,
      })
      throw error
    }
    if (acquiredClaim) {
      const failure = await failEvaluationRunAttempt({
        runId: payload.runId,
        tenantId: payload.tenantId,
        venueId: payload.venueId,
        runIdentityHash: payload.runIdentityHash,
        attemptNumber: acquiredClaim.attemptNumber,
        maxAttempts: execution.maxAttempts,
        leaseToken: acquiredClaim.leaseToken,
        errorCode: 'EVALUATION_EXECUTION_FAILED',
      })
      if (failure === 'failed' || failure === 'cancelled') await reconcileOnboardingMilestones()
    }
    await recordJobFailure({
      jobRecordId,
      error,
      errorMessage: error instanceof Error ? error.message : 'Unknown evaluation runner error',
      execution,
    })
    throw error
  }
}
