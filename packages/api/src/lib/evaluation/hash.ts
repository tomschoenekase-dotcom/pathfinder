import { createHash } from 'node:crypto'

import {
  canonicalEvaluationJson,
  EvalCaseSchema,
  EvalCaseManifestSchema,
  EvalObservationSchema,
  type EvalCase,
  type EvalCaseManifest,
  type EvalObservation,
} from './contracts'

type CanonicalObject = Parameters<typeof canonicalEvaluationJson>[0]

function sha256(domain: string, value: CanonicalObject): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalEvaluationJson(value)}`, 'utf8')
    .digest('hex')
}

export function hashEvalCase(value: EvalCase): string {
  const parsed = EvalCaseSchema.parse(value)
  return sha256('pathfinder-eval-case-v1', parsed as CanonicalObject)
}

export function hashEvalObservation(value: EvalObservation): string {
  const parsed = EvalObservationSchema.parse(value)
  return sha256('pathfinder-eval-observation-v1', parsed as CanonicalObject)
}

export function hashEvalCaseManifest(value: EvalCaseManifest): string {
  const parsed = EvalCaseManifestSchema.parse(value)
  return sha256('pathfinder-eval-corpus-manifest-v1', parsed as CanonicalObject)
}
