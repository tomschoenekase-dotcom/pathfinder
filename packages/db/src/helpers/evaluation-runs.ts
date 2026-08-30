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
const LEGACY_RUN_IDENTITY_VERSION = 'pathfinder-eval-run-identity-v2'
const NATIVE_RUN_IDENTITY_VERSION = 'pathfinder-eval-run-identity-v3'
const APPROVED_PACKAGE_RUN_IDENTITY_VERSION = 'pathfinder-eval-run-identity-v4'
const REVIEWABLE_PACKAGE_RUN_IDENTITY_VERSION = 'pathfinder-eval-run-identity-v5'

type EvaluationRunClient = Pick<typeof db, 'evalRun'>

type EvaluationRunIdentityBase = {
  tenantId: string
  venueId: string
  idempotencyKey: string
  caseManifest: EvalCaseManifest
  promptContractVersion: string
  promptContractHash: string
  packageSnapshotRef: string | null
  packageSnapshotHash: string | null
  contentSnapshotHash: string
  modelProvider: string
  modelName: string
  modelSnapshot: InputJsonValue
  runConfigSnapshot: InputJsonValue
  declaredBudgetCeilingE8Usd: bigint
  createdBy: string
  triggerType: string
}
export type EvaluationRunIdentity = EvaluationRunIdentityBase &
  (
    | {
        contentSnapshotKind?: 'LEGACY_VENUE_CONTENT_V1'
        contentSnapshotRef?: null
        contentSnapshotVersion: bigint
      }
    | {
        contentSnapshotKind: 'NATIVE_CORE_V1'
        contentSnapshotRef: string
        contentSnapshotVersion: bigint
      }
    | {
        contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1'
        contentSnapshotRef: string
        contentSnapshotVersion: bigint
      }
    | {
        contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1'
        contentSnapshotRef: string
        contentSnapshotVersion: bigint
      }
  )

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
  if (identity.contentSnapshotKind === 'NATIVE_CORE_V1') {
    if (!UUID_PATTERN.test(identity.contentSnapshotRef) || identity.contentSnapshotVersion < 1n)
      throw new EvaluationRunIdentityError('Native content snapshot identity is invalid')
  } else if (identity.contentSnapshotKind === 'APPROVED_VENUE_PACKAGE_V1') {
    if (!identity.contentSnapshotRef.trim() || identity.contentSnapshotVersion < 1n)
      throw new EvaluationRunIdentityError('Approved package content snapshot identity is invalid')
  } else if (identity.contentSnapshotKind === 'REVIEWABLE_VENUE_PACKAGE_V1') {
    if (!identity.contentSnapshotRef.trim() || identity.contentSnapshotVersion < 1n)
      throw new EvaluationRunIdentityError(
        'Reviewable package content snapshot identity is invalid',
      )
  } else if (identity.contentSnapshotRef !== undefined && identity.contentSnapshotRef !== null) {
    throw new EvaluationRunIdentityError('Legacy content snapshots cannot have a reference')
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
  const common = {
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
  return identity.contentSnapshotKind === 'NATIVE_CORE_V1'
    ? {
        version: NATIVE_RUN_IDENTITY_VERSION,
        ...common,
        contentSnapshotKind: 'NATIVE_CORE_V1',
        contentSnapshotRef: identity.contentSnapshotRef,
      }
    : identity.contentSnapshotKind === 'APPROVED_VENUE_PACKAGE_V1'
      ? {
          version: APPROVED_PACKAGE_RUN_IDENTITY_VERSION,
          ...common,
          contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1',
          contentSnapshotRef: identity.contentSnapshotRef,
        }
      : identity.contentSnapshotKind === 'REVIEWABLE_VENUE_PACKAGE_V1'
        ? {
            version: REVIEWABLE_PACKAGE_RUN_IDENTITY_VERSION,
            ...common,
            contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1',
            contentSnapshotRef: identity.contentSnapshotRef,
          }
        : { version: LEGACY_RUN_IDENTITY_VERSION, ...common }
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
    run.contentSnapshotKind ===
      (expected.version === NATIVE_RUN_IDENTITY_VERSION
        ? 'NATIVE_CORE_V1'
        : expected.version === APPROVED_PACKAGE_RUN_IDENTITY_VERSION
          ? 'APPROVED_VENUE_PACKAGE_V1'
          : expected.version === REVIEWABLE_PACKAGE_RUN_IDENTITY_VERSION
            ? 'REVIEWABLE_VENUE_PACKAGE_V1'
            : 'LEGACY_VENUE_CONTENT_V1') &&
    run.contentSnapshotRef ===
      (expected.version === NATIVE_RUN_IDENTITY_VERSION ||
      expected.version === APPROVED_PACKAGE_RUN_IDENTITY_VERSION ||
      expected.version === REVIEWABLE_PACKAGE_RUN_IDENTITY_VERSION
        ? expected.contentSnapshotRef
        : null) &&
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

/** Verifies that a persisted run still matches the immutable identity snapshot
 * that was hashed when it was created. Workers call this before reading any
 * snapshot into a provider prompt. */
export function isVerifiedEvaluationRunIdentity(run: EvalRun): boolean {
  const snapshot = run.identitySnapshot as CanonicalObject
  let identityHash: string
  try {
    identityHash = createHash('sha256')
      .update(canonicalEvaluationJson(snapshot), 'utf8')
      .digest('hex')
  } catch {
    return false
  }
  return isMatchingReplay(run, identityHash, snapshot)
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
        contentSnapshotKind:
          params.identity.contentSnapshotKind === 'NATIVE_CORE_V1'
            ? 'NATIVE_CORE_V1'
            : params.identity.contentSnapshotKind === 'APPROVED_VENUE_PACKAGE_V1'
              ? 'APPROVED_VENUE_PACKAGE_V1'
              : params.identity.contentSnapshotKind === 'REVIEWABLE_VENUE_PACKAGE_V1'
                ? 'REVIEWABLE_VENUE_PACKAGE_V1'
                : 'LEGACY_VENUE_CONTENT_V1',
        contentSnapshotRef:
          params.identity.contentSnapshotKind === 'NATIVE_CORE_V1' ||
          params.identity.contentSnapshotKind === 'APPROVED_VENUE_PACKAGE_V1' ||
          params.identity.contentSnapshotKind === 'REVIEWABLE_VENUE_PACKAGE_V1'
            ? params.identity.contentSnapshotRef
            : null,
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
