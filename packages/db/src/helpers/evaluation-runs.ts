import { createHash } from 'node:crypto'

import type { EvalRun } from '@prisma/client'
import type { InputJsonValue } from '@prisma/client/runtime/library'
import {
  canonicalEvaluationJson,
  EvalCaseManifestSchema,
  type CanonicalJsonValue,
  type EvalCaseManifest,
} from '@pathfinder/contracts/evaluation'
import {
  GUEST_CHAT_PROMPT_CONTRACT_HASH,
  GUEST_CHAT_PROMPT_VERSION,
} from '@pathfinder/contracts/prompt-contract'

import type { db } from '../client'
import { evaluationHash, hashEvalCaseManifest } from './evaluation-hash'

export { canonicalEvaluationJson } from '@pathfinder/contracts/evaluation'

const HASH_PATTERN = /^[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RUN_IDENTITY_VERSION = 'pathfinder-eval-run-identity-v2'

type EvaluationRunClient = Pick<typeof db, 'evalRun'>

export type EvaluationRunIdentity = {
  tenantId: string
  venueId: string
  idempotencyKey: string
  caseManifest: EvalCaseManifest
  promptContractVersion: string
  promptContractHash: string
  packageSnapshotRef: string | null
  packageSnapshotHash: string | null
  contentSnapshotVersion: bigint
  contentSnapshotHash: string
  modelProvider: string
  modelName: string
  modelSnapshot: InputJsonValue
  runConfigSnapshot: InputJsonValue
  declaredBudgetCeilingE8Usd: bigint
  createdBy: string
  triggerType: string
}

type CanonicalObject = { [key: string]: CanonicalJsonValue }

export class EvaluationRunIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationRunIdentityError'
  }
}

export class EvaluationRunReplayConflictError extends Error {
  constructor() {
    super('Evaluation run idempotency key was already used with a different identity')
    this.name = 'EvaluationRunReplayConflictError'
  }
}

export function evaluationSnapshotHash(domain: string, value: InputJsonValue): string {
  try {
    return evaluationHash(domain, inputJson(value))
  } catch (error) {
    throw new EvaluationRunIdentityError(error instanceof Error ? error.message : 'Invalid JSON')
  }
}

function inputJson(value: InputJsonValue): CanonicalJsonValue {
  return value as CanonicalJsonValue
}

function validateIdentity(identity: EvaluationRunIdentity): void {
  for (const [field, value] of [
    ['tenantId', identity.tenantId],
    ['venueId', identity.venueId],
    ['idempotencyKey', identity.idempotencyKey],
    ['promptContractVersion', identity.promptContractVersion],
    ['modelProvider', identity.modelProvider],
    ['modelName', identity.modelName],
    ['createdBy', identity.createdBy],
    ['triggerType', identity.triggerType],
  ] as const) {
    if (!value.trim()) throw new EvaluationRunIdentityError(`${field} must not be blank`)
  }
  for (const [field, value] of [
    ['promptContractHash', identity.promptContractHash],
    ['contentSnapshotHash', identity.contentSnapshotHash],
  ] as const) {
    if (!HASH_PATTERN.test(value)) {
      throw new EvaluationRunIdentityError(`${field} must be a lowercase SHA-256 digest`)
    }
  }
  if (identity.promptContractVersion !== GUEST_CHAT_PROMPT_VERSION) {
    throw new EvaluationRunIdentityError('promptContractVersion is not the production contract')
  }
  if (identity.promptContractHash !== GUEST_CHAT_PROMPT_CONTRACT_HASH) {
    throw new EvaluationRunIdentityError('promptContractHash is not the production contract')
  }
  if ((identity.packageSnapshotRef === null) !== (identity.packageSnapshotHash === null)) {
    throw new EvaluationRunIdentityError('package snapshot reference and hash must be paired')
  }
  if (identity.packageSnapshotRef !== null && !identity.packageSnapshotRef.trim()) {
    throw new EvaluationRunIdentityError('packageSnapshotRef must not be blank')
  }
  if (identity.packageSnapshotHash !== null && !HASH_PATTERN.test(identity.packageSnapshotHash)) {
    throw new EvaluationRunIdentityError('packageSnapshotHash must be a lowercase SHA-256 digest')
  }
  try {
    EvalCaseManifestSchema.parse(identity.caseManifest)
  } catch {
    throw new EvaluationRunIdentityError('caseManifest must be a valid non-empty ordered manifest')
  }
  if (identity.contentSnapshotVersion < 0n) {
    throw new EvaluationRunIdentityError('contentSnapshotVersion must be nonnegative')
  }
  if (identity.declaredBudgetCeilingE8Usd < 0n) {
    throw new EvaluationRunIdentityError('declaredBudgetCeilingE8Usd must be nonnegative')
  }
}

function identitySnapshot(identity: EvaluationRunIdentity): CanonicalObject {
  validateIdentity(identity)
  const caseManifest = EvalCaseManifestSchema.parse(identity.caseManifest)
  const corpusHash = hashEvalCaseManifest(caseManifest)
  const modelSnapshotHash = evaluationSnapshotHash(
    'pathfinder-eval-model-snapshot-v1',
    identity.modelSnapshot,
  )
  return {
    version: RUN_IDENTITY_VERSION,
    tenantId: identity.tenantId,
    venueId: identity.venueId,
    idempotencyKey: identity.idempotencyKey,
    corpusHash,
    caseManifest: caseManifest as CanonicalJsonValue,
    promptContractVersion: identity.promptContractVersion,
    promptContractHash: identity.promptContractHash,
    packageSnapshotRef: identity.packageSnapshotRef,
    packageSnapshotHash: identity.packageSnapshotHash,
    contentSnapshotVersion: identity.contentSnapshotVersion.toString(),
    contentSnapshotHash: identity.contentSnapshotHash,
    modelProvider: identity.modelProvider,
    modelName: identity.modelName,
    modelSnapshotHash,
    modelSnapshot: inputJson(identity.modelSnapshot),
    runConfigSnapshot: inputJson(identity.runConfigSnapshot),
    declaredBudgetCeilingE8Usd: identity.declaredBudgetCeilingE8Usd.toString(),
    createdBy: identity.createdBy,
    triggerType: identity.triggerType,
  }
}

export function evaluationRunIdentityHash(identity: EvaluationRunIdentity): string {
  return createHash('sha256')
    .update(canonicalEvaluationJson(identitySnapshot(identity)), 'utf8')
    .digest('hex')
}

function isMatchingReplay(run: EvalRun, identityHash: string, snapshot: CanonicalObject): boolean {
  const expected = snapshot
  return (
    run.identityHash === identityHash &&
    run.tenantId === expected.tenantId &&
    run.venueId === expected.venueId &&
    run.idempotencyKey === expected.idempotencyKey &&
    run.corpusHash === expected.corpusHash &&
    canonicalEvaluationJson(run.caseManifestSnapshot as CanonicalJsonValue) ===
      canonicalEvaluationJson(expected.caseManifest!) &&
    run.promptContractVersion === expected.promptContractVersion &&
    run.promptContractHash === expected.promptContractHash &&
    run.packageSnapshotRef === expected.packageSnapshotRef &&
    run.packageSnapshotHash === expected.packageSnapshotHash &&
    run.contentSnapshotVersion.toString() === expected.contentSnapshotVersion &&
    run.contentSnapshotHash === expected.contentSnapshotHash &&
    run.modelProvider === expected.modelProvider &&
    run.modelName === expected.modelName &&
    run.modelSnapshotHash === expected.modelSnapshotHash &&
    canonicalEvaluationJson(run.modelSnapshot as CanonicalJsonValue) ===
      canonicalEvaluationJson(expected.modelSnapshot!) &&
    canonicalEvaluationJson(run.runConfigSnapshot as CanonicalJsonValue) ===
      canonicalEvaluationJson(expected.runConfigSnapshot!) &&
    run.declaredBudgetCeilingE8Usd.toString() === expected.declaredBudgetCeilingE8Usd &&
    run.createdBy === expected.createdBy &&
    run.triggerType === expected.triggerType &&
    canonicalEvaluationJson(run.identitySnapshot as CanonicalJsonValue) ===
      canonicalEvaluationJson(snapshot)
  )
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

export async function createOrReplayEvaluationRun(params: {
  db: EvaluationRunClient
  runId: string
  identity: EvaluationRunIdentity
}): Promise<{ run: EvalRun; replayed: boolean }> {
  if (!UUID_PATTERN.test(params.runId)) {
    throw new EvaluationRunIdentityError('runId must be a valid UUID')
  }
  const snapshot = identitySnapshot(params.identity)
  const identityHash = evaluationRunIdentityHash(params.identity)
  const caseManifest = EvalCaseManifestSchema.parse(params.identity.caseManifest)
  const corpusHash = hashEvalCaseManifest(caseManifest)
  const modelSnapshotHash = evaluationSnapshotHash(
    'pathfinder-eval-model-snapshot-v1',
    params.identity.modelSnapshot,
  )
  const where = {
    tenantId: params.identity.tenantId,
    venueId: params.identity.venueId,
    idempotencyKey: params.identity.idempotencyKey,
  }

  const existing = await params.db.evalRun.findFirst({ where })
  if (existing) {
    if (!isMatchingReplay(existing, identityHash, snapshot)) {
      throw new EvaluationRunReplayConflictError()
    }
    return { run: existing, replayed: true }
  }

  try {
    const run = await params.db.evalRun.create({
      data: {
        id: params.runId,
        ...where,
        identityHash,
        corpusHash,
        caseManifestSnapshot: caseManifest,
        promptContractVersion: params.identity.promptContractVersion,
        promptContractHash: params.identity.promptContractHash,
        packageSnapshotRef: params.identity.packageSnapshotRef,
        packageSnapshotHash: params.identity.packageSnapshotHash,
        contentSnapshotVersion: params.identity.contentSnapshotVersion,
        contentSnapshotHash: params.identity.contentSnapshotHash,
        modelProvider: params.identity.modelProvider,
        modelName: params.identity.modelName,
        modelSnapshotHash,
        modelSnapshot: params.identity.modelSnapshot,
        runConfigSnapshot: params.identity.runConfigSnapshot,
        identitySnapshot: snapshot,
        declaredBudgetCeilingE8Usd: params.identity.declaredBudgetCeilingE8Usd,
        createdBy: params.identity.createdBy,
        triggerType: params.identity.triggerType,
      },
    })
    return { run, replayed: false }
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    const raced = await params.db.evalRun.findFirst({ where })
    if (!raced || !isMatchingReplay(raced, identityHash, snapshot)) {
      throw new EvaluationRunReplayConflictError()
    }
    return { run: raced, replayed: true }
  }
}
