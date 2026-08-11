import { createHash } from 'node:crypto'

import {
  INTAKE_ORCHESTRATION_STAGES,
  IntakeDiscrepancy,
  IntakeEvidence,
  IntakeProposal,
  IntakeSource,
  IntakeSourceKind,
  type IntakeDiscrepancy as IntakeDiscrepancyType,
  type IntakeEvidence as IntakeEvidenceType,
  type IntakeOrchestrationStage,
  type IntakeProposal as IntakeProposalType,
  type IntakeSource as IntakeSourceType,
  type IntakeSourceKind as IntakeSourceKindType,
} from '@pathfinder/contracts/intake-engine'

const EXECUTABLE_STAGES = [
  'DEDUPE',
  'EXTRACT',
  'RECONCILE',
  'ASSESS_UNCERTAINTY',
  'MAP_TO_CONTENT',
  'CREATE_PROPOSAL',
  'VALIDATE',
  'REVIEW',
] as const satisfies readonly IntakeOrchestrationStage[]

type ExecutableStage = (typeof EXECUTABLE_STAGES)[number]

export type IntakeClaim = {
  fieldPath: string
  value: string
  evidenceId: string
  dateSensitive?: boolean
  effectiveDate?: string
}

export type ConfiguredAdapterResult<TAdapterCandidate = unknown> = {
  status: 'EXTRACTED'
  sourceId: string
  evidence: readonly IntakeEvidenceType[]
  discrepancies: readonly IntakeDiscrepancyType[]
  claims: readonly IntakeClaim[]
  costUnits: number
  candidate?: TAdapterCandidate
}

export type NotConfiguredAdapterResult = {
  status: 'NOT_CONFIGURED'
  sourceId: string
  sourceKind: IntakeSourceKindType
  reason: 'ADAPTER_NOT_CONFIGURED'
  evidence: readonly []
  discrepancies: readonly []
  claims: readonly []
  costUnits: 0
}

export type BlockedAdapterResult = {
  status: 'BLOCKED'
  sourceId: string
  sourceKind: IntakeSourceKindType
  reason: 'CONSENT_REQUIRED'
  missingInformation: readonly string[]
  evidence: readonly []
  discrepancies: readonly []
  claims: readonly []
  costUnits: 0
}

export type IntakeAdapterResult<TAdapterCandidate = unknown> =
  | ConfiguredAdapterResult<TAdapterCandidate>
  | NotConfiguredAdapterResult
  | BlockedAdapterResult

export type IntakeAdapterContext = {
  signal: AbortSignal | undefined
  remainingCostUnits: number
  remainingTimeMs: number
}

export type IntakeSourceAdapter<
  TAdapterCandidate = unknown,
  TKind extends 'WEBSITE' | 'INTERVIEW' = 'WEBSITE' | 'INTERVIEW',
> = {
  kind: TKind
  extract: (
    source: IntakeSourceType & { kind: TKind },
    context: IntakeAdapterContext,
  ) => Promise<ConfiguredAdapterResult<TAdapterCandidate> | BlockedAdapterResult>
}

export type IntakeAdapterRegistry<TAdapterCandidate = unknown> = {
  sourceKinds: readonly IntakeSourceKindType[]
  run: (
    source: IntakeSourceType,
    context: IntakeAdapterContext,
  ) => Promise<IntakeAdapterResult<TAdapterCandidate>>
}

export function createIntakeAdapterRegistry<TAdapterCandidate = unknown>(options?: {
  website?: IntakeSourceAdapter<TAdapterCandidate, 'WEBSITE'>
  interview?: IntakeSourceAdapter<TAdapterCandidate, 'INTERVIEW'>
}): IntakeAdapterRegistry<TAdapterCandidate> {
  const sourceKinds = [...IntakeSourceKind.options]
  return {
    sourceKinds,
    async run(source, context) {
      const configuredAdapter =
        source.kind === 'WEBSITE'
          ? options?.website
          : source.kind === 'INTERVIEW'
            ? options?.interview
            : undefined
      if (configuredAdapter) {
        const result = await configuredAdapter.extract(source as never, context)
        if (
          (result.status !== 'EXTRACTED' && result.status !== 'BLOCKED') ||
          result.sourceId !== source.id
        ) {
          throw new IntakeOrchestrationError(
            'INVALID_ADAPTER_RESULT',
            `${source.kind} adapter returned an invalid result for ${source.id}`,
          )
        }
        return result
      }
      return {
        status: 'NOT_CONFIGURED',
        sourceId: source.id,
        sourceKind: source.kind,
        reason: 'ADAPTER_NOT_CONFIGURED',
        evidence: [],
        discrepancies: [],
        claims: [],
        costUnits: 0,
      }
    },
  }
}

export type IntakeBudget = {
  maxSources: number
  maxEvidence: number
  maxDiscrepancies: number
  maxCostUnits: number
  maxDurationMs: number
}

export type PackageDraftHandoffInput<TDraftCandidate> = {
  runId: string
  tenantId: string
  venueId: string
  draftKey: string
  candidate: TDraftCandidate
  evidenceIds: readonly string[]
  discrepancyIds: readonly string[]
  reviewMode: 'DRAFT_ONLY'
  signal: AbortSignal | undefined
  remainingTimeMs: number
}

export type PackageDraftHandoff<TDraftCandidate> = {
  createDraftForReview: (
    input: PackageDraftHandoffInput<TDraftCandidate>,
  ) => Promise<{ packageDraftId: string; validationResultId?: string }>
}

export type IntakeLifecycleEvent = {
  eventId: string
  runId: string
  sequence: number
  stage: ExecutableStage
  state: 'STARTED' | 'COMPLETED' | 'STOPPED'
  occurredAt: string
  reason: IntakeStopReason | null
}

export type IntakeStopReason =
  | 'CANCELLED'
  | 'BUDGET_EXCEEDED'
  | 'ADAPTER_NOT_CONFIGURED'
  | 'CONSENT_REQUIRED'

export type IntakeOrchestrationRequest = {
  sources: readonly IntakeSourceType[]
  budget: IntakeBudget
  signal?: AbortSignal
}

export type IntakeOrchestrationDependencies<TAdapterCandidate, TDraftCandidate> = {
  registry: IntakeAdapterRegistry<TAdapterCandidate>
  buildDraftCandidate?: (input: {
    runId: string
    tenantId: string
    venueId: string
    adapterCandidates: readonly TAdapterCandidate[]
    evidence: readonly IntakeEvidenceType[]
    discrepancies: readonly IntakeDiscrepancyType[]
    signal: AbortSignal | undefined
    remainingTimeMs: number
  }) => Promise<TDraftCandidate>
  draftHandoff?: PackageDraftHandoff<TDraftCandidate>
  onEvent?: (event: IntakeLifecycleEvent) => void | Promise<void>
  now?: () => Date
}

export type IntakeOrchestrationResult<TAdapterCandidate = unknown> = {
  proposal: IntakeProposalType
  stopReason: IntakeStopReason | null
  dedupeKey: string
  duplicateSourceIds: Readonly<Record<string, string>>
  adapterResults: readonly IntakeAdapterResult<TAdapterCandidate>[]
  evidence: readonly IntakeEvidenceType[]
  discrepancies: readonly IntakeDiscrepancyType[]
  events: readonly IntakeLifecycleEvent[]
  budget: { costUnitsUsed: number; sourcesProcessed: number }
  execution: { autoPublish: false; autoApply: false; lifecycleCommands: readonly [] }
}

export class IntakeOrchestrationError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'INVALID_ADAPTER_RESULT' | 'INVALID_PROPOSAL',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeOrchestrationError'
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function uuidFromHash(value: string) {
  const hex = hash(value)
  const body = `${hex.slice(0, 12)}4${hex.slice(13, 16)}a${hex.slice(17, 20)}${hex.slice(20, 32)}`
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20)}`
}

function canonicalSourceUri(uri: string | undefined) {
  if (!uri) return null
  try {
    const url = new URL(uri)
    url.hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    url.hash = ''
    url.searchParams.sort()
    return url.toString()
  } catch {
    return uri.trim()
  }
}

function sourceFingerprint(source: IntakeSourceType) {
  return hash(
    stableJson({
      tenantId: source.tenantId,
      venueId: source.venueId,
      kind: source.kind,
      uri: canonicalSourceUri(source.uri),
      assetId: source.assetId ?? null,
      fallbackId: source.uri || source.assetId ? null : source.id,
    }),
  )
}

function dedupeSources(sources: readonly IntakeSourceType[]) {
  const groups = new Map<string, IntakeSourceType[]>()
  for (const source of sources) {
    const fingerprint = sourceFingerprint(source)
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), source])
  }
  const unique: IntakeSourceType[] = []
  const duplicates: Record<string, string> = {}
  for (const [, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...group].sort((left, right) => left.id.localeCompare(right.id))
    const primary = sorted[0]
    if (!primary) continue
    unique.push(primary)
    for (const duplicate of sorted.slice(1)) duplicates[duplicate.id] = primary.id
  }
  return { unique, duplicates }
}

function validateBudget(budget: IntakeBudget) {
  const values = Object.values(budget)
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new IntakeOrchestrationError(
      'INVALID_INPUT',
      'Intake budget values must be positive integers',
    )
  }
  if (
    budget.maxSources > 500 ||
    budget.maxEvidence > 5_000 ||
    budget.maxDiscrepancies > 1_000 ||
    budget.maxCostUnits > 1_000_000 ||
    budget.maxDurationMs > 3_600_000
  ) {
    throw new IntakeOrchestrationError('INVALID_INPUT', 'Intake budget exceeds safety bounds')
  }
}

function normalizedClaim(value: string) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function reconcile(
  adapterResults: readonly ConfiguredAdapterResult[],
  maxEvidence: number,
  maxDiscrepancies: number,
) {
  const evidenceById = new Map<string, IntakeEvidenceType>()
  const discrepancyById = new Map<string, IntakeDiscrepancyType>()
  const claimsByField = new Map<string, IntakeClaim[]>()
  for (const result of adapterResults) {
    for (const rawEvidence of result.evidence) {
      const evidence = IntakeEvidence.parse(rawEvidence)
      const existing = evidenceById.get(evidence.id)
      if (existing && stableJson(existing) !== stableJson(evidence)) {
        throw new IntakeOrchestrationError(
          'INVALID_ADAPTER_RESULT',
          `Evidence ${evidence.id} has conflicting definitions`,
        )
      }
      evidenceById.set(evidence.id, evidence)
    }
    for (const rawDiscrepancy of result.discrepancies) {
      const discrepancy = IntakeDiscrepancy.parse(rawDiscrepancy)
      const existing = discrepancyById.get(discrepancy.id)
      if (existing && stableJson(existing) !== stableJson(discrepancy)) {
        throw new IntakeOrchestrationError(
          'INVALID_ADAPTER_RESULT',
          `Discrepancy ${discrepancy.id} has conflicting definitions`,
        )
      }
      discrepancyById.set(discrepancy.id, discrepancy)
    }
    for (const claim of result.claims) {
      if (
        !claim.fieldPath.trim() ||
        !claim.value.trim() ||
        !evidenceById.has(claim.evidenceId) ||
        (claim.effectiveDate !== undefined && Number.isNaN(Date.parse(claim.effectiveDate)))
      ) {
        throw new IntakeOrchestrationError('INVALID_ADAPTER_RESULT', 'Adapter claim is invalid')
      }
      claimsByField.set(claim.fieldPath, [...(claimsByField.get(claim.fieldPath) ?? []), claim])
    }
  }
  for (const [fieldPath, claims] of [...claimsByField].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (new Set(claims.map((claim) => normalizedClaim(claim.value))).size < 2) continue
    const evidenceIds = [...new Set(claims.map((claim) => claim.evidenceId))].sort()
    const id = `discrepancy_${hash(`${fieldPath}:${evidenceIds.join(':')}`).slice(0, 24)}`
    if (!discrepancyById.has(id)) {
      discrepancyById.set(
        id,
        IntakeDiscrepancy.parse({
          id,
          fieldPath,
          evidenceIds,
          reason: claims.some(
            (claim) => claim.dateSensitive === true || claim.effectiveDate !== undefined,
          )
            ? 'DATE_SENSITIVE'
            : 'CONTRADICTION',
        }),
      )
    }
  }
  const evidence = [...evidenceById.values()].sort((left, right) => left.id.localeCompare(right.id))
  const discrepancies = [...discrepancyById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  const evidenceIds = new Set(evidence.map((item) => item.id))
  if (
    discrepancies.some((item) =>
      item.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId)),
    )
  ) {
    throw new IntakeOrchestrationError(
      'INVALID_ADAPTER_RESULT',
      'Discrepancy references unknown evidence',
    )
  }
  return {
    evidence,
    discrepancies,
    exceeded: evidence.length > maxEvidence || discrepancies.length > maxDiscrepancies,
  }
}

export async function orchestrateIntake<TAdapterCandidate = unknown, TDraftCandidate = unknown>(
  request: IntakeOrchestrationRequest,
  dependencies: IntakeOrchestrationDependencies<TAdapterCandidate, TDraftCandidate>,
): Promise<IntakeOrchestrationResult<TAdapterCandidate>> {
  validateBudget(request.budget)
  if (request.sources.length === 0 || request.sources.length > 500) {
    throw new IntakeOrchestrationError(
      'INVALID_INPUT',
      'Include between one and 500 intake sources',
    )
  }
  const sources = request.sources.map((source) => IntakeSource.parse(source))
  const tenantId = sources[0]?.tenantId
  const venueId = sources[0]?.venueId
  if (
    !tenantId ||
    !venueId ||
    sources.some((source) => source.tenantId !== tenantId || source.venueId !== venueId)
  ) {
    throw new IntakeOrchestrationError(
      'INVALID_INPUT',
      'All intake sources must share tenant and venue scope',
    )
  }
  const { unique, duplicates } = dedupeSources(sources)
  const dedupeKey = hash(
    stableJson({
      sources: unique.map(sourceFingerprint).sort(),
      budget: request.budget,
    }),
  )
  const runId = `intake_${dedupeKey.slice(0, 24)}`
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().getTime()
  const events: IntakeLifecycleEvent[] = []
  const adapterResults: IntakeAdapterResult<TAdapterCandidate>[] = []
  let costUnitsUsed = 0
  let sourcesProcessed = 0

  const emit = async (
    stage: ExecutableStage,
    state: IntakeLifecycleEvent['state'],
    reason: IntakeStopReason | null = null,
  ) => {
    const sequence = events.length + 1
    const event: IntakeLifecycleEvent = {
      eventId: `event_${hash(`${runId}:${sequence}:${stage}:${state}`).slice(0, 24)}`,
      runId,
      sequence,
      stage,
      state,
      occurredAt: now().toISOString(),
      reason,
    }
    events.push(event)
    await dependencies.onEvent?.(event)
  }
  const isCancelled = () => request.signal?.aborted === true
  const remainingTime = () => request.budget.maxDurationMs - (now().getTime() - startedAt)
  const makeProposal = (
    status: 'AWAITING_REVIEW' | 'FAILED' | 'CANCELLED',
    evidence: readonly IntakeEvidenceType[],
    discrepancies: readonly IntakeDiscrepancyType[],
    draft?: { packageDraftId: string; validationResultId?: string },
  ) =>
    IntakeProposal.parse({
      runId,
      status,
      sourceIds: unique.map((source) => source.id),
      evidenceIds: evidence.map((item) => item.id),
      discrepancyIds: discrepancies.map((item) => item.id),
      ...(draft?.packageDraftId ? { packageDraftId: draft.packageDraftId } : {}),
      ...(draft?.validationResultId ? { validationResultId: draft.validationResultId } : {}),
      autoPublish: false,
    })
  const finish = (
    proposal: IntakeProposalType,
    stopReason: IntakeStopReason | null,
    evidence: readonly IntakeEvidenceType[],
    discrepancies: readonly IntakeDiscrepancyType[],
  ): IntakeOrchestrationResult<TAdapterCandidate> => ({
    proposal,
    stopReason,
    dedupeKey,
    duplicateSourceIds: duplicates,
    adapterResults,
    evidence,
    discrepancies,
    events,
    budget: { costUnitsUsed, sourcesProcessed },
    execution: { autoPublish: false, autoApply: false, lifecycleCommands: [] },
  })

  await emit('DEDUPE', 'STARTED')
  if (isCancelled()) {
    await emit('DEDUPE', 'STOPPED', 'CANCELLED')
    return finish(makeProposal('CANCELLED', [], []), 'CANCELLED', [], [])
  }
  if (unique.length > request.budget.maxSources) {
    await emit('DEDUPE', 'STOPPED', 'BUDGET_EXCEEDED')
    return finish(makeProposal('FAILED', [], []), 'BUDGET_EXCEEDED', [], [])
  }
  await emit('DEDUPE', 'COMPLETED')
  await emit('EXTRACT', 'STARTED')
  for (const source of unique) {
    if (isCancelled()) {
      await emit('EXTRACT', 'STOPPED', 'CANCELLED')
      return finish(makeProposal('CANCELLED', [], []), 'CANCELLED', [], [])
    }
    const remainingTimeMs = remainingTime()
    const remainingCostUnits = request.budget.maxCostUnits - costUnitsUsed
    if (remainingTimeMs <= 0 || remainingCostUnits <= 0) {
      await emit('EXTRACT', 'STOPPED', 'BUDGET_EXCEEDED')
      return finish(makeProposal('FAILED', [], []), 'BUDGET_EXCEEDED', [], [])
    }
    let result: IntakeAdapterResult<TAdapterCandidate>
    try {
      result = await dependencies.registry.run(source, {
        signal: request.signal,
        remainingCostUnits,
        remainingTimeMs,
      })
    } catch (error) {
      if (!isCancelled()) throw error
      await emit('EXTRACT', 'STOPPED', 'CANCELLED')
      return finish(makeProposal('CANCELLED', [], []), 'CANCELLED', [], [])
    }
    if (isCancelled()) {
      await emit('EXTRACT', 'STOPPED', 'CANCELLED')
      return finish(makeProposal('CANCELLED', [], []), 'CANCELLED', [], [])
    }
    if (!Number.isInteger(result.costUnits) || result.costUnits < 0) {
      throw new IntakeOrchestrationError(
        'INVALID_ADAPTER_RESULT',
        'Adapter cost must be a non-negative integer',
      )
    }
    adapterResults.push(result)
    sourcesProcessed += 1
    costUnitsUsed += result.costUnits
    if (
      costUnitsUsed > request.budget.maxCostUnits ||
      result.evidence.length > request.budget.maxEvidence ||
      result.discrepancies.length > request.budget.maxDiscrepancies ||
      result.claims.length > request.budget.maxEvidence * 2 ||
      remainingTime() <= 0
    ) {
      await emit('EXTRACT', 'STOPPED', 'BUDGET_EXCEEDED')
      return finish(makeProposal('FAILED', [], []), 'BUDGET_EXCEEDED', [], [])
    }
  }
  await emit('EXTRACT', 'COMPLETED')
  await emit('RECONCILE', 'STARTED')
  if (adapterResults.some((result) => result.status === 'NOT_CONFIGURED')) {
    await emit('RECONCILE', 'STOPPED', 'ADAPTER_NOT_CONFIGURED')
    return finish(makeProposal('FAILED', [], []), 'ADAPTER_NOT_CONFIGURED', [], [])
  }
  if (adapterResults.some((result) => result.status === 'BLOCKED')) {
    await emit('RECONCILE', 'STOPPED', 'CONSENT_REQUIRED')
    return finish(makeProposal('FAILED', [], []), 'CONSENT_REQUIRED', [], [])
  }
  const configured = adapterResults as ConfiguredAdapterResult<TAdapterCandidate>[]
  const reconciled = reconcile(
    configured,
    request.budget.maxEvidence,
    request.budget.maxDiscrepancies,
  )
  if (reconciled.exceeded) {
    await emit('RECONCILE', 'STOPPED', 'BUDGET_EXCEEDED')
    return finish(makeProposal('FAILED', [], []), 'BUDGET_EXCEEDED', [], [])
  }
  await emit('RECONCILE', 'COMPLETED')
  await emit('ASSESS_UNCERTAINTY', 'STARTED')
  await emit('ASSESS_UNCERTAINTY', 'COMPLETED')
  await emit('MAP_TO_CONTENT', 'STARTED')
  let draftCandidate: TDraftCandidate | undefined
  if (dependencies.buildDraftCandidate) {
    draftCandidate = await dependencies.buildDraftCandidate({
      runId,
      tenantId,
      venueId,
      adapterCandidates: configured.flatMap((result) =>
        result.candidate === undefined ? [] : [result.candidate],
      ),
      evidence: reconciled.evidence,
      discrepancies: reconciled.discrepancies,
      signal: request.signal,
      remainingTimeMs: remainingTime(),
    })
  }
  if (isCancelled()) {
    await emit('MAP_TO_CONTENT', 'STOPPED', 'CANCELLED')
    return finish(
      makeProposal('CANCELLED', reconciled.evidence, reconciled.discrepancies),
      'CANCELLED',
      reconciled.evidence,
      reconciled.discrepancies,
    )
  }
  if (remainingTime() <= 0) {
    await emit('MAP_TO_CONTENT', 'STOPPED', 'BUDGET_EXCEEDED')
    return finish(
      makeProposal('FAILED', reconciled.evidence, reconciled.discrepancies),
      'BUDGET_EXCEEDED',
      reconciled.evidence,
      reconciled.discrepancies,
    )
  }
  await emit('MAP_TO_CONTENT', 'COMPLETED')
  await emit('CREATE_PROPOSAL', 'STARTED')
  let draft: { packageDraftId: string; validationResultId?: string } | undefined
  if (draftCandidate !== undefined && dependencies.draftHandoff) {
    draft = await dependencies.draftHandoff.createDraftForReview({
      runId,
      tenantId,
      venueId,
      draftKey: uuidFromHash(`draft:${dedupeKey}`),
      candidate: draftCandidate,
      evidenceIds: reconciled.evidence.map((item) => item.id),
      discrepancyIds: reconciled.discrepancies.map((item) => item.id),
      reviewMode: 'DRAFT_ONLY',
      signal: request.signal,
      remainingTimeMs: remainingTime(),
    })
    if (!draft.packageDraftId) {
      throw new IntakeOrchestrationError('INVALID_PROPOSAL', 'Draft handoff returned no draft ID')
    }
  }
  await emit('CREATE_PROPOSAL', 'COMPLETED')
  await emit('VALIDATE', 'STARTED')
  const proposal = makeProposal(
    'AWAITING_REVIEW',
    reconciled.evidence,
    reconciled.discrepancies,
    draft,
  )
  const proposalEvidence = new Set(proposal.evidenceIds)
  if (
    reconciled.discrepancies.some((item) =>
      item.evidenceIds.some((evidenceId) => !proposalEvidence.has(evidenceId)),
    )
  ) {
    throw new IntakeOrchestrationError(
      'INVALID_PROPOSAL',
      'Validated proposal omitted discrepancy evidence',
    )
  }
  await emit('VALIDATE', 'COMPLETED')
  await emit('REVIEW', 'STARTED')
  await emit('REVIEW', 'COMPLETED')
  return finish(proposal, null, reconciled.evidence, reconciled.discrepancies)
}

export const INTAKE_EXECUTABLE_STAGES = EXECUTABLE_STAGES
export const INTAKE_NON_AUTOMATED_STAGES = INTAKE_ORCHESTRATION_STAGES.filter(
  (stage) => !EXECUTABLE_STAGES.includes(stage as ExecutableStage),
)

export {
  createStaffInterviewSourceAdapter,
  StaffInterviewAdapterError,
} from './staff-interview-adapter'
export type { StaffInterviewCandidate, StaffInterviewPublicAnswer } from './staff-interview-adapter'
