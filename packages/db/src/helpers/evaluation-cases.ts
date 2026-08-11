import type { EvalCase } from '@prisma/client'
import {
  canonicalEvaluationJson,
  EvalCaseSchema,
  type CanonicalJsonValue,
  type EvalCase as EvalCaseContract,
} from '@pathfinder/contracts/evaluation'

import type { db } from '../client'
import { hashEvalCase } from './evaluation-hash'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type EvaluationCaseClient = Pick<typeof db, 'evalCase'>

export type EvaluationCaseIdentity = {
  tenantId: string
  venueId: string
  caseKey: string
  revision: number
  schemaVersion: string
  category: string
  caseSnapshot: EvalCaseContract
  createdBy: string
  sourceType: string
  sourceRef: string
}

export class EvaluationCaseIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationCaseIdentityError'
  }
}

export class EvaluationCaseReplayConflictError extends Error {
  constructor() {
    super('Evaluation case revision already exists with different immutable content')
    this.name = 'EvaluationCaseReplayConflictError'
  }
}

function validate(identity: EvaluationCaseIdentity): EvalCaseContract {
  for (const [field, value] of [
    ['tenantId', identity.tenantId],
    ['venueId', identity.venueId],
    ['caseKey', identity.caseKey],
    ['schemaVersion', identity.schemaVersion],
    ['category', identity.category],
    ['createdBy', identity.createdBy],
    ['sourceType', identity.sourceType],
    ['sourceRef', identity.sourceRef],
  ] as const) {
    if (!value.trim()) throw new EvaluationCaseIdentityError(`${field} must not be blank`)
  }
  if (!Number.isInteger(identity.revision) || identity.revision < 1) {
    throw new EvaluationCaseIdentityError('revision must be a positive integer')
  }
  const parsed = EvalCaseSchema.safeParse(identity.caseSnapshot)
  if (!parsed.success) throw new EvaluationCaseIdentityError('caseSnapshot is not a valid EvalCase')
  if (
    identity.caseKey !== parsed.data.caseId ||
    identity.schemaVersion !== parsed.data.schemaVersion ||
    identity.category !== parsed.data.category
  ) {
    throw new EvaluationCaseIdentityError(
      'caseKey, schemaVersion, and category must match the validated case snapshot',
    )
  }
  return parsed.data
}

function sameCase(row: EvalCase, identity: EvaluationCaseIdentity, caseHash: string): boolean {
  return (
    row.caseHash === caseHash &&
    row.schemaVersion === identity.schemaVersion &&
    row.category === identity.category &&
    row.createdBy === identity.createdBy &&
    row.sourceType === identity.sourceType &&
    row.sourceRef === identity.sourceRef &&
    canonicalEvaluationJson(row.caseSnapshot as CanonicalJsonValue) ===
      canonicalEvaluationJson(identity.caseSnapshot as CanonicalJsonValue)
  )
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function createOrReplayEvaluationCase(params: {
  db: EvaluationCaseClient
  caseId: string
  identity: EvaluationCaseIdentity
}): Promise<{ evalCase: EvalCase; replayed: boolean }> {
  if (!UUID_PATTERN.test(params.caseId)) {
    throw new EvaluationCaseIdentityError('caseId must be a valid UUID')
  }
  const caseSnapshot = validate(params.identity)
  const caseHash = hashEvalCase(caseSnapshot)
  const where = {
    tenantId: params.identity.tenantId,
    venueId: params.identity.venueId,
    caseKey: params.identity.caseKey,
    revision: params.identity.revision,
  }
  const existing = await params.db.evalCase.findFirst({ where })
  if (existing) {
    if (!sameCase(existing, params.identity, caseHash)) {
      throw new EvaluationCaseReplayConflictError()
    }
    return { evalCase: existing, replayed: true }
  }

  try {
    const evalCase = await params.db.evalCase.create({
      data: {
        id: params.caseId,
        ...where,
        schemaVersion: params.identity.schemaVersion,
        category: params.identity.category,
        caseHash,
        caseSnapshot,
        createdBy: params.identity.createdBy,
        sourceType: params.identity.sourceType,
        sourceRef: params.identity.sourceRef,
      },
    })
    return { evalCase, replayed: false }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const raced = await params.db.evalCase.findFirst({ where })
    if (!raced || !sameCase(raced, params.identity, caseHash)) {
      throw new EvaluationCaseReplayConflictError()
    }
    return { evalCase: raced, replayed: true }
  }
}
