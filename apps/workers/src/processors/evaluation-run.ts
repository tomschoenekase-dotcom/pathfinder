import {
  createEvalObservation,
  EvalCaseManifestSchema,
  EvalCaseSchema,
  scoreEvaluationChecks,
  type EvalCase,
  type EvalObservation,
  type EvalResult,
} from '@pathfinder/contracts/evaluation'
import type { EvaluationRunJobPayload } from '@pathfinder/jobs'
import { hashEvalObservation } from '@pathfinder/db'

export const EVALUATION_RUN_MAX_CASES = 50

export type FrozenEvaluationRun = {
  id: string
  tenantId: string
  venueId: string
  identityHash: string
  caseManifestSnapshot: unknown
  modelProvider: string
  modelName: string
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
  evaluate(params: { run: FrozenEvaluationRun; evalCase: EvalCase }): Promise<EvaluationAttempt>
  persist(params: {
    run: FrozenEvaluationRun
    evalCase: FrozenEvaluationCase
    terminal: EvaluationTerminalEvidence
  }): Promise<void>
  isCancelled?(runId: string): Promise<boolean>
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

/** Pure orchestration seam. Queue/DB/provider adapters remain injectable so tests
 * cannot contact Redis, Postgres, or a model provider. */
export async function executeFrozenEvaluationRun(
  payload: EvaluationRunJobPayload,
  deps: EvaluationRunnerDependencies,
  options: { finalAttempt: boolean },
): Promise<{ processed: number; costE8Usd: bigint }> {
  const run = await deps.loadRun(payload)
  if (
    !run ||
    run.tenantId !== payload.tenantId ||
    run.venueId !== payload.venueId ||
    run.identityHash !== payload.runIdentityHash
  ) {
    throw new Error('EVALUATION_RUN_IDENTITY_MISMATCH')
  }
  const manifest = EvalCaseManifestSchema.parse(run.caseManifestSnapshot)
  if (manifest.length > EVALUATION_RUN_MAX_CASES) throw new Error('EVALUATION_CASE_LIMIT_EXCEEDED')
  const cases = await deps.loadCases({ tenantId: run.tenantId, venueId: run.venueId, manifest })
  const byIdentity = new Map(
    cases.map((item) => [`${item.id}:${item.revision}:${item.caseHash}`, item]),
  )
  let spent = 0n
  let processed = 0

  for (const entry of manifest) {
    const frozenCase = byIdentity.get(`${entry.caseId}:${entry.revision}:${entry.caseHash}`)
    if (!frozenCase) throw new Error('EVALUATION_CASE_IDENTITY_MISMATCH')
    if (await deps.isCancelled?.(run.id)) {
      await deps.persist({
        run,
        evalCase: frozenCase,
        terminal: { outcome: 'CANCELLED', errorCode: 'RUN_CANCELLED', latencyMs: 0, costE8Usd: 0n },
      })
      processed += 1
      continue
    }
    if (spent >= run.declaredBudgetCeilingE8Usd) {
      await deps.persist({
        run,
        evalCase: frozenCase,
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
    const evalCase = EvalCaseSchema.parse(frozenCase.caseSnapshot)
    try {
      const attempt = await deps.evaluate({ run, evalCase })
      if (attempt.modelProvider !== run.modelProvider || attempt.modelName !== run.modelName)
        throw new Error('EVALUATION_MODEL_IDENTITY_MISMATCH')
      if (attempt.costE8Usd < 0n || spent + attempt.costE8Usd > run.declaredBudgetCeilingE8Usd) {
        await deps.persist({
          run,
          evalCase: frozenCase,
          terminal: {
            outcome: 'BUDGET_BLOCKED',
            errorCode: 'RUN_BUDGET_CEILING',
            latencyMs: attempt.latencyMs,
            costE8Usd: 0n,
          },
        })
      } else {
        spent += attempt.costE8Usd
        const observation = createEvalObservation({
          caseId: evalCase.caseId,
          answer: attempt.answer,
        })
        await deps.persist({
          run,
          evalCase: frozenCase,
          terminal: {
            outcome: 'SCORED',
            observation,
            result: resultFor(evalCase, observation, frozenCase.caseHash),
            latencyMs: attempt.latencyMs,
            costE8Usd: attempt.costE8Usd,
          },
        })
      }
      processed += 1
    } catch (error) {
      if (!options.finalAttempt) throw error
      await deps.persist({
        run,
        evalCase: frozenCase,
        terminal: {
          outcome: 'OPERATIONAL_FAILURE',
          errorCode: 'MODEL_EXECUTION_FAILED',
          latencyMs: 0,
          costE8Usd: 0n,
        },
      })
      processed += 1
    }
  }
  return { processed, costE8Usd: spent }
}
