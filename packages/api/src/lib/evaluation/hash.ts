import { createHash } from 'node:crypto'

import {
  EvalCaseSchema,
  EvalObservationSchema,
  type EvalCase,
  type EvalObservation,
} from './contracts'

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | CanonicalObject
type CanonicalObject = { [key: string]: CanonicalValue }

function canonicalJson(value: CanonicalValue): string {
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical JSON does not support non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key.normalize('NFC'))}:${canonicalJson(value[key]!)}`)
    .join(',')}}`
}

function sha256(domain: string, value: CanonicalValue): string {
  return createHash('sha256')
    .update(`${domain}\n${canonicalJson(value)}`, 'utf8')
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
