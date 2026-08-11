import { createHash } from 'node:crypto'

import {
  canonicalEvaluationJson,
  EvalCaseManifestSchema,
  EvalCaseSchema,
  EvalObservationSchema,
  type CanonicalJsonValue,
  type EvalCase,
  type EvalCaseManifest,
  type EvalObservation,
} from '@pathfinder/contracts/evaluation'

export function evaluationHash(domain: string, value: CanonicalJsonValue): string {
  if (!domain.trim()) throw new Error('Hash domain must not be blank')
  return createHash('sha256')
    .update(`${domain}\n${canonicalEvaluationJson(value)}`, 'utf8')
    .digest('hex')
}

export function hashEvalCase(value: EvalCase): string {
  const parsed = EvalCaseSchema.parse(value)
  return evaluationHash('pathfinder-eval-case-v1', parsed as CanonicalJsonValue)
}

export function hashEvalObservation(value: EvalObservation): string {
  const parsed = EvalObservationSchema.parse(value)
  return evaluationHash('pathfinder-eval-observation-v1', parsed as CanonicalJsonValue)
}

export function hashEvalCaseManifest(value: EvalCaseManifest): string {
  const parsed = EvalCaseManifestSchema.parse(value)
  return evaluationHash('pathfinder-eval-corpus-manifest-v1', parsed as CanonicalJsonValue)
}
