import * as prismaClient from '@prisma/client'
import type { EvalResult as PersistedEvalResult } from '@prisma/client'
import {
  canonicalEvaluationJson,
  EvalCaseManifestSchema,
  EvalCaseSchema,
  EvalObservationSchema,
  EvalResultSchema,
  scoreEvaluationChecks,
  type CanonicalJsonValue,
  type EvalObservation,
  type EvalResult,
} from '@pathfinder/contracts/evaluation'

import type { db } from '../client'
import { hashEvalCase, hashEvalObservation } from './evaluation-hash'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_INT32 = 2_147_483_647
const MAX_INT64 = 9_223_372_036_854_775_807n

type EvaluationResultClient = Pick<typeof db, 'evalRun' | 'evalCase' | 'evalResult'>
export type EvaluationResultTerminal =
  | {
      outcome: 'SCORED'
      observation: EvalObservation
      result: EvalResult
      errorCode?: never
    }
  | {
      outcome: 'OPERATIONAL_FAILURE'
      errorCode: 'PROVIDER_OUTCOME_AMBIGUOUS' | 'PROVIDER_COST_INVARIANT'
      observation?: never
      result?: never
    }
  | {
      outcome: 'ADMISSION_DEFERRED'
      errorCode: 'VENUE_AI_PAUSED'
      observation?: never
      result?: never
    }
  | {
      outcome: 'BUDGET_BLOCKED'
      errorCode: 'RUN_BUDGET_CEILING'
      observation?: never
      result?: never
    }
  | {
      outcome: 'CANCELLED'
      errorCode: 'RUN_CANCELLED'
      observation?: never
      result?: never
    }

type OperationalTerminal = Exclude<EvaluationResultTerminal, { outcome: 'SCORED' }>
type OperationalOutcome = OperationalTerminal['outcome']

const operationalErrorCodes: {
  [Outcome in OperationalOutcome]: ReadonlySet<
    Extract<OperationalTerminal, { outcome: Outcome }>['errorCode']
  >
} = {
  OPERATIONAL_FAILURE: new Set(['PROVIDER_OUTCOME_AMBIGUOUS', 'PROVIDER_COST_INVARIANT']),
  ADMISSION_DEFERRED: new Set(['VENUE_AI_PAUSED']),
  BUDGET_BLOCKED: new Set(['RUN_BUDGET_CEILING']),
  CANCELLED: new Set(['RUN_CANCELLED']),
}

function isAdmittedOperationalTerminal(
  terminal: OperationalTerminal,
): terminal is OperationalTerminal {
  return operationalErrorCodes[terminal.outcome].has(terminal.errorCode as never)
}

export class EvaluationResultIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationResultIdentityError'
  }
}

export class EvaluationResultReplayConflictError extends Error {
  constructor() {
    super('Evaluation result already exists with different immutable evidence')
    this.name = 'EvaluationResultReplayConflictError'
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right
  return (
    canonicalEvaluationJson(left as CanonicalJsonValue) ===
    canonicalEvaluationJson(right as CanonicalJsonValue)
  )
}

type ExpectedResult = {
  tenantId: string
  venueId: string
  runId: string
  runIdentityHash: string
  caseId: string
  caseRevision: number
  caseHash: string
  outcome: 'SCORED' | OperationalOutcome
  observationHash: string | null
  observationSnapshot: CanonicalJsonValue | null
  checksSnapshot: CanonicalJsonValue | null
  passed: boolean | null
  passedChecks: number | null
  totalChecks: number | null
  errorCode: string | null
  latencyMs: number
  costE8Usd: bigint
}

function isMatchingReplay(row: PersistedEvalResult, expected: ExpectedResult): boolean {
  return (
    row.tenantId === expected.tenantId &&
    row.venueId === expected.venueId &&
    row.runId === expected.runId &&
    row.runIdentityHash === expected.runIdentityHash &&
    row.caseId === expected.caseId &&
    row.caseRevision === expected.caseRevision &&
    row.caseHash === expected.caseHash &&
    row.outcome === expected.outcome &&
    row.observationHash === expected.observationHash &&
    sameJson(row.observationSnapshot, expected.observationSnapshot) &&
    sameJson(row.checksSnapshot, expected.checksSnapshot) &&
    row.passed === expected.passed &&
    row.passedChecks === expected.passedChecks &&
    row.totalChecks === expected.totalChecks &&
    row.errorCode === expected.errorCode &&
    row.latencyMs === expected.latencyMs &&
    row.costE8Usd === expected.costE8Usd
  )
}

export async function createOrReplayEvaluationResult(params: {
  db: EvaluationResultClient
  resultId: string
  tenantId: string
  venueId: string
  runId: string
  evalCaseId: string
  caseRevision: number
  latencyMs: number
  costE8Usd: bigint
  terminal: EvaluationResultTerminal
}): Promise<{ evalResult: PersistedEvalResult; replayed: boolean }> {
  for (const [field, value] of [
    ['resultId', params.resultId],
    ['runId', params.runId],
    ['evalCaseId', params.evalCaseId],
  ] as const) {
    if (!UUID_PATTERN.test(value))
      throw new EvaluationResultIdentityError(`${field} must be a UUID`)
  }
  if (!params.tenantId.trim() || !params.venueId.trim()) {
    throw new EvaluationResultIdentityError('tenantId and venueId must not be blank')
  }
  if (!Number.isInteger(params.caseRevision) || params.caseRevision < 1) {
    throw new EvaluationResultIdentityError('caseRevision must be a positive integer')
  }
  if (
    !Number.isSafeInteger(params.latencyMs) ||
    params.latencyMs < 0 ||
    params.latencyMs > MAX_INT32
  ) {
    throw new EvaluationResultIdentityError('latencyMs must be a nonnegative 32-bit integer')
  }
  if (params.costE8Usd < 0n || params.costE8Usd > MAX_INT64) {
    throw new EvaluationResultIdentityError('costE8Usd must be a nonnegative 64-bit integer')
  }
  if (params.terminal.outcome !== 'SCORED' && !isAdmittedOperationalTerminal(params.terminal)) {
    throw new EvaluationResultIdentityError('errorCode is not admitted for the terminal outcome')
  }

  const [run, evalCase] = await Promise.all([
    params.db.evalRun.findFirst({
      where: { id: params.runId, tenantId: params.tenantId, venueId: params.venueId },
    }),
    params.db.evalCase.findFirst({
      where: {
        id: params.evalCaseId,
        revision: params.caseRevision,
        tenantId: params.tenantId,
        venueId: params.venueId,
      },
    }),
  ])
  if (!run || !evalCase) throw new EvaluationResultIdentityError('Run or case is outside scope')

  const parsedCase = EvalCaseSchema.safeParse(evalCase.caseSnapshot)
  if (
    !parsedCase.success ||
    parsedCase.data.caseId !== evalCase.caseKey ||
    hashEvalCase(parsedCase.data) !== evalCase.caseHash
  ) {
    throw new EvaluationResultIdentityError('Stored evaluation case failed integrity verification')
  }
  const manifest = EvalCaseManifestSchema.safeParse(run.caseManifestSnapshot)
  if (
    !manifest.success ||
    !manifest.data.some(
      (entry) =>
        entry.caseId === evalCase.id &&
        entry.revision === evalCase.revision &&
        entry.caseHash === evalCase.caseHash,
    )
  ) {
    throw new EvaluationResultIdentityError('Case is not an exact member of the run manifest')
  }

  let quality: Omit<
    ExpectedResult,
    | 'tenantId'
    | 'venueId'
    | 'runId'
    | 'runIdentityHash'
    | 'caseId'
    | 'caseRevision'
    | 'caseHash'
    | 'latencyMs'
    | 'costE8Usd'
  >
  if (params.terminal.outcome === 'SCORED') {
    const observation = EvalObservationSchema.parse(params.terminal.observation)
    const result = EvalResultSchema.parse(params.terminal.result)
    const observationHash = hashEvalObservation(observation)
    const expectedChecks = scoreEvaluationChecks(parsedCase.data, observation)
    if (
      observation.caseId !== evalCase.caseKey ||
      result.caseId !== evalCase.caseKey ||
      result.caseHash !== evalCase.caseHash ||
      result.observationHash !== observationHash ||
      observation.expectedPromptContractVersion !== run.promptContractVersion
    ) {
      throw new EvaluationResultIdentityError(
        'Scored result does not match its run, case, or observation',
      )
    }
    if (
      canonicalEvaluationJson(result.checks as CanonicalJsonValue) !==
      canonicalEvaluationJson(expectedChecks as CanonicalJsonValue)
    ) {
      throw new EvaluationResultIdentityError(
        'Scored result checks do not match deterministic scoring',
      )
    }
    quality = {
      outcome: 'SCORED',
      observationHash,
      observationSnapshot: observation as CanonicalJsonValue,
      checksSnapshot: result.checks as CanonicalJsonValue,
      passed: result.passed,
      passedChecks: result.checks.filter((check) => check.passed).length,
      totalChecks: result.checks.length,
      errorCode: null,
    }
  } else {
    quality = {
      outcome: params.terminal.outcome,
      observationHash: null,
      observationSnapshot: null,
      checksSnapshot: null,
      passed: null,
      passedChecks: null,
      totalChecks: null,
      errorCode: params.terminal.errorCode,
    }
  }

  const expected: ExpectedResult = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    runId: run.id,
    runIdentityHash: run.identityHash,
    caseId: evalCase.id,
    caseRevision: evalCase.revision,
    caseHash: evalCase.caseHash,
    latencyMs: params.latencyMs,
    costE8Usd: params.costE8Usd,
    ...quality,
  }
  const where = {
    tenantId: params.tenantId,
    venueId: params.venueId,
    runId: run.id,
    caseId: evalCase.id,
    caseRevision: evalCase.revision,
  }
  const existing = await params.db.evalResult.findFirst({ where })
  if (existing) {
    if (!isMatchingReplay(existing, expected)) throw new EvaluationResultReplayConflictError()
    return { evalResult: existing, replayed: true }
  }

  try {
    const evalResult = await params.db.evalResult.create({
      data: {
        id: params.resultId,
        ...expected,
        observationSnapshot:
          expected.observationSnapshot === null
            ? prismaClient['Prisma']['DbNull']
            : expected.observationSnapshot,
        checksSnapshot:
          expected.checksSnapshot === null
            ? prismaClient['Prisma']['DbNull']
            : expected.checksSnapshot,
      },
    })
    return { evalResult, replayed: false }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const raced = await params.db.evalResult.findFirst({ where })
    if (!raced || !isMatchingReplay(raced, expected)) {
      throw new EvaluationResultReplayConflictError()
    }
    return { evalResult: raced, replayed: true }
  }
}
