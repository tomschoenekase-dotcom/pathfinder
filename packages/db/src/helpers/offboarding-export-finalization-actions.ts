import { createHash } from 'node:crypto'

import type { OffboardingExportKind } from '@prisma/client'

import { db } from '../client'
import type { OffboardingPlanHumanActor } from './offboarding-plan-actions'

export type OffboardingExportFinalizationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INCOMPLETE'

export class OffboardingExportFinalizationError extends Error {
  constructor(
    readonly code: OffboardingExportFinalizationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'OffboardingExportFinalizationError'
  }
}

type ExportReference = {
  id: string
  version: string
  recordedAt: string
  classification:
    | 'APPROVED_PUBLIC'
    | 'CLIENT_HISTORY'
    | 'PACKAGE_EVIDENCE'
    | 'SAFE_CONFIGURATION'
    | 'DIRECT_VENUE_AUDIT_REFERENCE'
}

export type FrozenOffboardingExportManifest = {
  schemaVersion: 1
  privacyBoundary: 'BOUNDED_EXPORT_EVIDENCE'
  tenantId: string
  planId: string
  venueId: string
  kind: OffboardingExportKind
  records: ExportReference[]
  recordCount: number
  sourceComplete: true
}

export type OffboardingExportStorage = {
  putExact(input: {
    key: string
    bytes: Uint8Array
    contentHash: string
  }): Promise<{ versionId: string }>
}

export type FinalizeOffboardingExportActionInput = {
  tenantId: string
  planId: string
  venueId: string
  kind: OffboardingExportKind
  operationId: string
  expectedPlanUpdatedAt: Date
  actor: OffboardingPlanHumanActor
}

export async function reviewOffboardingPlanForExportAction(
  input: {
    tenantId: string
    planId: string
    operationId: string
    expectedUpdatedAt: Date
    actor: OffboardingPlanHumanActor
  },
  client: Client = db,
) {
  if (
    !input.tenantId.trim() ||
    !input.planId.trim() ||
    Number.isNaN(input.expectedUpdatedAt.getTime())
  ) {
    fail('INVALID_INPUT', 'Exact plan scope and expected version are required')
  }
  if (!UUID.test(input.operationId)) fail('INVALID_INPUT', 'A valid review operation is required')
  const reviewHash = sha256(
    [
      'pathfinder.offboarding-export-review.v1',
      input.tenantId,
      input.planId,
      input.expectedUpdatedAt.toISOString(),
      input.actor.id,
      input.operationId.toLowerCase(),
    ].join('|'),
  )
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  ) {
    fail('INVALID_INPUT', 'A human platform administrator is required')
  }
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const plan = await tx.offboardingPlan.findFirst({
      where: { id: input.planId, tenantId: input.tenantId },
      select: {
        status: true,
        updatedAt: true,
        exportKinds: true,
        exportReviewOperationId: true,
        exportReviewOperationHash: true,
        exportReviewedBy: true,
        exportReviewedAt: true,
        _count: { select: { venueTargets: true } },
      },
    })
    if (!plan) fail('NOT_FOUND', 'Offboarding plan was not found')
    if (plan.exportReviewOperationId === input.operationId) {
      if (
        plan.exportReviewOperationHash !== reviewHash ||
        plan.exportReviewedBy !== input.actor.id ||
        !plan.exportReviewedAt ||
        !['REVIEWED', 'EXPORT_READY', 'CANCELLED'].includes(plan.status)
      ) {
        fail('CONFLICT', 'Review operation evidence is inconsistent')
      }
      return {
        planId: input.planId,
        status: 'REVIEWED' as const,
        updatedAt: plan.exportReviewedAt,
        replayed: true,
      }
    }
    if (
      plan.status !== 'REQUESTED' ||
      plan.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    ) {
      fail('CONFLICT', 'The offboarding plan changed before review')
    }
    if (!plan.exportKinds.length || !plan._count.venueTargets)
      fail('INVALID_INPUT', 'The plan has no export matrix')
    const reviewedAt = new Date()
    const audit = await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'offboarding-plan.export-reviewed',
        targetType: 'OffboardingPlan',
        targetId: input.planId,
        beforeState: { status: 'REQUESTED' },
        afterState: {
          status: 'REVIEWED',
          venueCount: plan._count.venueTargets,
          exportKinds: plan.exportKinds,
        },
        createdAt: reviewedAt,
      },
      select: { id: true },
    })
    const changed = await tx.offboardingPlan.updateMany({
      where: {
        id: input.planId,
        tenantId: input.tenantId,
        status: 'REQUESTED',
        updatedAt: input.expectedUpdatedAt,
      },
      data: {
        status: 'REVIEWED',
        updatedAt: reviewedAt,
        exportReviewOperationId: input.operationId,
        exportReviewOperationHash: reviewHash,
        exportReviewedBy: input.actor.id,
        exportReviewedAt: reviewedAt,
        exportReviewAuditId: audit.id,
      },
    })
    if (changed.count !== 1) fail('CONFLICT', 'The offboarding plan changed before review')
    return {
      planId: input.planId,
      status: 'REVIEWED' as const,
      updatedAt: reviewedAt,
      replayed: false,
    }
  })
}

type Client = Pick<typeof db, '$transaction'>
type ManifestBuilder = (
  input: Pick<FinalizeOffboardingExportActionInput, 'tenantId' | 'planId' | 'venueId' | 'kind'>,
) => Promise<FrozenOffboardingExportManifest>

const KIND_CLASSIFICATION: Record<OffboardingExportKind, ExportReference['classification']> = {
  APPROVED_CONTENT: 'APPROVED_PUBLIC',
  CONTENT_HISTORY: 'CLIENT_HISTORY',
  VENUE_PACKAGES: 'PACKAGE_EVIDENCE',
  CONFIGURATION: 'SAFE_CONFIGURATION',
  AUDIT_HISTORY: 'DIRECT_VENUE_AUDIT_REFERENCE',
}

const RECORD_CAPS: Record<OffboardingExportKind, number> = {
  APPROVED_CONTENT: 1_000,
  CONTENT_HISTORY: 2_000,
  VENUE_PACKAGES: 500,
  CONFIGURATION: 100,
  AUDIT_HISTORY: 2_000,
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fail(code: OffboardingExportFinalizationErrorCode, message: string): never {
  throw new OffboardingExportFinalizationError(code, message)
}

function requireInput(input: FinalizeOffboardingExportActionInput): void {
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  ) {
    fail('INVALID_INPUT', 'A human platform administrator is required')
  }
  if (![input.tenantId, input.planId, input.venueId].every((value) => value.trim())) {
    fail('INVALID_INPUT', 'Exact tenant, plan and venue scope is required')
  }
  if (!UUID.test(input.operationId) || Number.isNaN(input.expectedPlanUpdatedAt.getTime())) {
    fail('INVALID_INPUT', 'A valid operation and expected plan version are required')
  }
}

function requireManifest(
  manifest: FrozenOffboardingExportManifest,
  input: FinalizeOffboardingExportActionInput,
): void {
  const records = manifest.records
  if (
    Object.keys(manifest).sort().join(',') !==
      'kind,planId,privacyBoundary,recordCount,records,schemaVersion,sourceComplete,tenantId,venueId' ||
    manifest.schemaVersion !== 1 ||
    manifest.privacyBoundary !== 'BOUNDED_EXPORT_EVIDENCE' ||
    manifest.tenantId !== input.tenantId ||
    manifest.planId !== input.planId ||
    manifest.venueId !== input.venueId ||
    manifest.kind !== input.kind ||
    manifest.sourceComplete !== true ||
    manifest.recordCount !== records.length ||
    records.length > RECORD_CAPS[input.kind]
  ) {
    fail('INCOMPLETE', 'The export manifest is incomplete or inconsistent')
  }
  const expected = KIND_CLASSIFICATION[input.kind]
  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      Object.keys(record).sort().join(',') !== 'classification,id,recordedAt,version' ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      record.id.length > 191 ||
      typeof record.version !== 'string' ||
      !record.version.trim() ||
      record.version.length > 191 ||
      record.classification !== expected ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.recordedAt) ||
      Number.isNaN(new Date(record.recordedAt).getTime())
    ) {
      fail('INCOMPLETE', 'The export manifest contains unsupported or unsafe record evidence')
    }
  }
}

function operationHash(input: FinalizeOffboardingExportActionInput): string {
  return sha256(
    [
      'pathfinder.offboarding-export-finalization.v1',
      input.tenantId,
      input.planId,
      input.venueId,
      input.kind,
      input.operationId.toLowerCase(),
      input.expectedPlanUpdatedAt.toISOString(),
      input.actor.id,
    ].join('|'),
  )
}

function objectKey(input: FinalizeOffboardingExportActionInput): string {
  return `offboarding/${input.operationId.toLowerCase()}/${input.tenantId}/${input.venueId}/${input.kind}.json`
}

async function result(
  tx: typeof db,
  input: FinalizeOffboardingExportActionInput,
  replayed: boolean,
) {
  const [operation, plan, required, settled] = await Promise.all([
    tx.offboardingExportOperation.findFirst({
      where: {
        id: input.operationId,
        tenantId: input.tenantId,
        planId: input.planId,
        venueId: input.venueId,
      },
      select: { status: true, kind: true },
    }),
    tx.offboardingPlan.findFirst({
      where: { id: input.planId, tenantId: input.tenantId },
      select: {
        status: true,
        updatedAt: true,
        exportKinds: true,
        _count: { select: { venueTargets: true } },
      },
    }),
    tx.offboardingVenueTarget.count({ where: { planId: input.planId, tenantId: input.tenantId } }),
    tx.offboardingExportArtifact.count({
      where: { planId: input.planId, tenantId: input.tenantId, operationId: { not: null } },
    }),
  ])
  if (!operation || operation.kind !== input.kind || !plan)
    fail('CONFLICT', 'Export evidence is inconsistent')
  const remainingArtifacts = Math.max(0, required * plan.exportKinds.length - settled)
  return {
    planId: input.planId,
    venueId: input.venueId,
    kind: input.kind,
    status: operation.status,
    artifactRecorded: operation.status === 'SETTLED',
    replayed,
    planStatus:
      plan.status === 'REVIEWED' || plan.status === 'EXPORT_READY' || plan.status === 'CANCELLED'
        ? plan.status
        : fail('CONFLICT', 'Offboarding plan is not in an export finalization state'),
    remainingArtifacts,
    planUpdatedAt: plan.updatedAt,
  }
}

export async function finalizeOffboardingExportAction(
  input: FinalizeOffboardingExportActionInput,
  dependencies: {
    client?: Client
    buildManifest: ManifestBuilder
    storage: OffboardingExportStorage
  },
) {
  requireInput(input)
  const client = dependencies.client ?? db
  const hash = operationHash(input)

  const auth = await client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const plan = await tx.offboardingPlan.findFirst({
      where: {
        id: input.planId,
        tenantId: input.tenantId,
        venueTargets: { some: { venueId: input.venueId } },
      },
      select: { status: true, updatedAt: true, exportKinds: true },
    })
    if (!plan) fail('NOT_FOUND', 'Offboarding export scope was not found')
    const existing = await tx.offboardingExportOperation.findFirst({
      where: {
        id: input.operationId,
        tenantId: input.tenantId,
        planId: input.planId,
        venueId: input.venueId,
      },
      select: {
        operationHash: true,
        requestedBy: true,
        status: true,
        canonicalManifest: true,
        canonicalBytes: true,
        contentHash: true,
        objectKey: true,
        storedVersionId: true,
        storedAt: true,
        byteLength: true,
      },
    })
    if (existing) {
      if (existing.operationHash !== hash || existing.requestedBy !== input.actor.id) {
        fail('CONFLICT', 'Operation ID is bound to different export input')
      }
      if (
        existing.status !== 'SETTLED' &&
        (plan.status !== 'REVIEWED' ||
          plan.updatedAt.getTime() !== input.expectedPlanUpdatedAt.getTime() ||
          !plan.exportKinds.includes(input.kind))
      ) {
        fail('CONFLICT', 'The reviewed offboarding plan changed before export continuation')
      }
      return { replay: true as const, existing }
    }
    if (
      plan.status !== 'REVIEWED' ||
      plan.updatedAt.getTime() !== input.expectedPlanUpdatedAt.getTime()
    ) {
      fail('CONFLICT', 'The reviewed offboarding plan changed')
    }
    if (!plan.exportKinds.includes(input.kind))
      fail('INVALID_INPUT', 'Export kind is not declared by the plan')
    return { replay: false as const, existing: null }
  })
  if (auth.existing?.status === 'SETTLED') {
    return client.$transaction((tx) => result(tx as unknown as typeof db, input, true))
  }

  let durableExisting = auth.existing
  const manifest = durableExisting
    ? (JSON.parse(durableExisting.canonicalBytes) as FrozenOffboardingExportManifest)
    : await dependencies.buildManifest(input)
  requireManifest(manifest, input)
  const canonicalManifest = canonicalJson(manifest)
  const bytes = new TextEncoder().encode(canonicalManifest)
  if (bytes.byteLength > 1_048_576)
    fail('INCOMPLETE', 'The export manifest exceeds the bounded size')
  const contentHash = sha256(canonicalManifest)
  const key = durableExisting?.objectKey ?? objectKey(input)
  if (
    durableExisting &&
    (durableExisting.contentHash !== contentHash || durableExisting.byteLength !== bytes.byteLength)
  ) {
    fail('CONFLICT', 'Reserved export bytes do not match durable evidence')
  }
  const now = new Date()

  if (!durableExisting)
    try {
      await client.$transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        await tx.offboardingExportOperation.create({
          data: {
            id: input.operationId,
            tenantId: input.tenantId,
            planId: input.planId,
            venueId: input.venueId,
            kind: input.kind,
            operationHash: hash,
            canonicalManifest: JSON.parse(canonicalManifest) as object,
            canonicalBytes: canonicalManifest,
            contentHash,
            byteLength: bytes.byteLength,
            objectKey: key,
            expectedPlanUpdatedAt: input.expectedPlanUpdatedAt,
            requestedBy: input.actor.id,
            requestedAt: now,
          },
        })
      })
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002'))
        throw error
      const converged = await client.$transaction(async (rawTx) => {
        const tx = rawTx as unknown as typeof db
        return tx.offboardingExportOperation.findFirst({
          where: {
            id: input.operationId,
            tenantId: input.tenantId,
            planId: input.planId,
            venueId: input.venueId,
          },
          select: {
            operationHash: true,
            requestedBy: true,
            status: true,
            contentHash: true,
            byteLength: true,
            objectKey: true,
            canonicalManifest: true,
            canonicalBytes: true,
            storedVersionId: true,
            storedAt: true,
          },
        })
      })
      if (
        !converged ||
        converged.operationHash !== hash ||
        converged.requestedBy !== input.actor.id ||
        converged.contentHash !== contentHash ||
        converged.byteLength !== bytes.byteLength ||
        converged.objectKey !== key ||
        canonicalJson(converged.canonicalManifest) !== canonicalManifest ||
        converged.canonicalBytes !== canonicalManifest
      ) {
        fail('CONFLICT', 'A concurrent export reservation used this operation or export tuple')
      }
      if (converged.status === 'SETTLED') {
        return client.$transaction((tx) => result(tx as unknown as typeof db, input, true))
      }
      durableExisting = converged
    }

  const stored = durableExisting?.storedVersionId
    ? { versionId: durableExisting.storedVersionId }
    : await dependencies.storage.putExact({ key, bytes, contentHash })
  if (!stored.versionId?.trim())
    fail('CONFLICT', 'Storage did not return immutable version evidence')

  try {
    await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const storedAt = new Date()
      if (durableExisting?.status !== 'STORED') {
        const updated = await tx.offboardingExportOperation.updateMany({
          where: {
            id: input.operationId,
            tenantId: input.tenantId,
            status: 'RESERVED',
            operationHash: hash,
          },
          data: { status: 'STORED', storedVersionId: stored.versionId, storedAt },
        })
        if (updated.count !== 1) fail('CONFLICT', 'Export reservation ownership was lost')
      }
      await tx.offboardingExportArtifact.create({
        data: {
          tenantId: input.tenantId,
          planId: input.planId,
          venueId: input.venueId,
          kind: input.kind,
          operationId: input.operationId,
          artifactReference: key,
          contentHash,
          createdBy: input.actor.id,
          createdAt: durableExisting?.storedAt ?? storedAt,
        },
      })
      const audit = await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'offboarding-export.artifact-finalized',
          targetType: 'OffboardingPlan',
          targetId: input.planId,
          afterState: {
            venueId: input.venueId,
            kind: input.kind,
            operationId: input.operationId,
            byteLength: bytes.byteLength,
          },
          createdAt: storedAt,
        },
        select: { id: true },
      })
      await tx.offboardingExportOperation.update({
        where: { id: input.operationId },
        data: { status: 'SETTLED', settledAt: storedAt, settlementAuditId: audit.id },
      })
      const [targets, artifacts, plan] = await Promise.all([
        tx.offboardingVenueTarget.count({
          where: { tenantId: input.tenantId, planId: input.planId },
        }),
        tx.offboardingExportArtifact.count({
          where: { tenantId: input.tenantId, planId: input.planId, operationId: { not: null } },
        }),
        tx.offboardingPlan.findFirst({
          where: { tenantId: input.tenantId, id: input.planId },
          select: { exportKinds: true },
        }),
      ])
      if (plan && artifacts === targets * plan.exportKinds.length) {
        await tx.offboardingPlan.updateMany({
          where: {
            tenantId: input.tenantId,
            id: input.planId,
            status: 'REVIEWED',
            updatedAt: input.expectedPlanUpdatedAt,
          },
          data: { status: 'EXPORT_READY', updatedAt: storedAt },
        })
      }
    })
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002'))
      throw error
    const converged = await client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      return tx.offboardingExportOperation.findFirst({
        where: {
          id: input.operationId,
          tenantId: input.tenantId,
          planId: input.planId,
          venueId: input.venueId,
        },
        select: { operationHash: true, requestedBy: true, status: true },
      })
    })
    if (
      !converged ||
      converged.operationHash !== hash ||
      converged.requestedBy !== input.actor.id ||
      converged.status !== 'SETTLED'
    ) {
      fail('CONFLICT', 'Concurrent export settlement did not converge')
    }
    return client.$transaction((tx) => result(tx as unknown as typeof db, input, true))
  }
  return client.$transaction((tx) => result(tx as unknown as typeof db, input, auth.replay))
}
