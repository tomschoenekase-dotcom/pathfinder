import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import {
  canonicalDeploymentManifest,
  deploymentManifestHash,
  VenueDeploymentManifest,
  VenueDeploymentMaterializationReport,
  type VenueDeploymentManifest as Manifest,
  type VenueDeploymentMaterializationReport as MaterializationReport,
} from '@pathfinder/contracts/venue-deployment-manifest'
import { lockVenueContentMutation } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { canonicalVenuePackagePayload } from '../schemas/venue-package'
import { previewDeploymentManifestConversion } from './venue-deployment-manifest'
import { createVenuePackageDraftService } from '../routers/venue-package'

type DbClient = TRPCContext['db']
type Actor = { type: 'HUMAN'; id: string; role: 'OWNER' | 'PLATFORM_ADMIN' }

const sections = [
  'IDENTITY',
  'BRANDING',
  'AI_CONFIGURATION',
  'CAPABILITIES',
  'CONTENT',
  'ASSETS',
  'EVALUATION',
] as const

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function packagePayloadDigest(value: string) {
  // Venue-package payloadHash is defined by venue-package.ts as SHA-256 over the
  // JSON representation of the canonical payload string. Keep manifest linkage
  // byte-identical to that authoritative contract.
  return digest(JSON.stringify(value))
}

function evidenceDigest(manifest: Manifest) {
  const moduleEvidence =
    manifest.packageType === 'FULL'
      ? manifest.contentModules.flatMap((module) => module.evidence)
      : manifest.operations.flatMap((operation) =>
          operation.op === 'UPSERT_CONTENT_MODULE' ? operation.value.evidence : [],
        )
  return digest(
    JSON.stringify({
      provenance: {
        ...manifest.provenance,
        sourceIds: [...manifest.provenance.sourceIds].sort(),
        evidenceIds: [...manifest.provenance.evidenceIds].sort(),
      },
      moduleEvidence: moduleEvidence
        .map((item) => ({ ...item }))
        .sort((left, right) =>
          `${left.evidenceId}:${left.sourceId}:${left.locator}`.localeCompare(
            `${right.evidenceId}:${right.sourceId}:${right.locator}`,
          ),
        ),
    }),
  )
}

function operationSection(manifest: Manifest, path: string) {
  if (manifest.packageType !== 'PATCH') return null
  const match = /^operations\.(\d+)/u.exec(path)
  if (!match) return null
  const operation = manifest.operations[Number(match[1])]
  if (!operation) return null
  if (operation.op === 'UPSERT_IDENTITY') return 'IDENTITY'
  if (operation.op === 'UPSERT_BRANDING') return 'BRANDING'
  if (operation.op === 'UPSERT_AI_CONFIGURATION') return 'AI_CONFIGURATION'
  if (
    operation.op === 'SET_PRESET' ||
    operation.op === 'SET_EFFECTIVE_CONFIG_PROVENANCE' ||
    operation.op === 'RETIRE_EFFECTIVE_CONFIG_PROVENANCE' ||
    operation.op === 'SET_CAPABILITY'
  )
    return 'CAPABILITIES'
  if (operation.op === 'UPSERT_ASSET' || operation.op === 'RETIRE_ASSET') return 'ASSETS'
  if (operation.op === 'SET_EVALUATION_REFERENCES') return 'EVALUATION'
  if (operation.op === 'RESET_CONFIGURATION') {
    if (operation.path.startsWith('branding.')) return 'BRANDING'
    if (operation.path.startsWith('aiConfiguration.')) return 'AI_CONFIGURATION'
    if (operation.path.startsWith('capabilities.')) return 'CAPABILITIES'
  }
  return 'CONTENT'
}

function reportFor(input: { manifest: Manifest; venueId: string; baseFound: boolean }): {
  report: MaterializationReport
  legacyDraftInput: unknown | null
} {
  const converted = previewDeploymentManifestConversion({
    venueId: input.venueId,
    manifest: input.manifest,
  })
  const issues = converted.issues
    .filter(
      (issue) =>
        issue.code !== 'BASE_HASH_DELEGATED' &&
        issue.code !== 'EVIDENCE_METADATA_NOT_PERSISTED' &&
        issue.code !== 'MODULE_EVIDENCE_NOT_PERSISTED',
    )
    .map((issue) => ({ ...issue }))
  if (input.manifest.packageType === 'FULL') {
    issues.push({
      severity: 'ERROR',
      code: 'FULL_COMPLETENESS_NOT_PROVEN',
      path: 'packageType',
      message:
        'FULL materialization is gated until every declared deployment section has exact normalized persistence and rollback truth.',
    })
  } else if (!input.baseFound) {
    issues.push({
      severity: 'ERROR',
      code: 'FULL_BASE_NOT_FOUND',
      path: 'baseManifestHash',
      message: 'PATCH materialization requires an exact persisted same-scope FULL base.',
    })
  }
  const errorSections = new Set<string>()
  for (const issue of issues.filter((item) => item.severity === 'ERROR')) {
    const path = issue.path
    const section = operationSection(input.manifest, path)
    if (section) errorSections.add(section)
    else if (path.startsWith('identity') || path.includes('IDENTITY')) errorSections.add('IDENTITY')
    else if (path.startsWith('branding')) errorSections.add('BRANDING')
    else if (path.startsWith('aiConfiguration')) errorSections.add('AI_CONFIGURATION')
    else if (path.startsWith('capabilities')) errorSections.add('CAPABILITIES')
    else if (path.startsWith('assets')) errorSections.add('ASSETS')
    else if (path.startsWith('evaluation')) errorSections.add('EVALUATION')
    else errorSections.add('CONTENT')
  }
  if (input.manifest.packageType === 'FULL')
    for (const section of sections) errorSections.add(section)
  const materializable =
    input.manifest.packageType === 'PATCH' && input.baseFound && converted.compatible
  const payloadHash =
    materializable && converted.payload
      ? packagePayloadDigest(canonicalVenuePackagePayload(input.venueId, converted.payload))
      : null
  const report = VenueDeploymentMaterializationReport.parse({
    artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
    manifestHash: deploymentManifestHash(input.manifest),
    baseManifestHash:
      input.manifest.packageType === 'PATCH' ? input.manifest.baseManifestHash : null,
    status: materializable ? 'MATERIALIZABLE' : 'NOT_MATERIALIZABLE',
    coverage: Object.fromEntries(
      sections.map((section) => [section, errorSections.has(section) ? 'BLOCKED' : 'COMPLETE']),
    ),
    issues: issues.sort((left, right) =>
      `${left.code}:${left.path}:${left.message}`.localeCompare(
        `${right.code}:${right.path}:${right.message}`,
      ),
    ),
    legacyPayloadHash: payloadHash,
  })
  return {
    report,
    legacyDraftInput:
      materializable && converted.payload
        ? {
            venueId: input.venueId,
            draftKey: input.manifest.idempotencyKey,
            payload: converted.payload,
          }
        : null,
  }
}

function isUniqueConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function hasCode(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

const artifactSelect = { id: true, manifestHash: true, createdBy: true } as const

export async function reviewVenuePackageManifestService(input: {
  db: DbClient
  tenantId: string
  venueId: string
  actor: Actor
  manifest: unknown
  persist: boolean
}) {
  if (
    input.actor.type !== 'HUMAN' ||
    (input.actor.role !== 'OWNER' && input.actor.role !== 'PLATFORM_ADMIN') ||
    input.actor.id.trim().length === 0
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manifest review actor is not authorized.' })
  }
  const manifest = VenueDeploymentManifest.parse(input.manifest)
  if (manifest.venueRef !== input.venueId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Manifest venue scope does not match.' })
  }
  const canonicalManifest = canonicalDeploymentManifest(manifest)
  const manifestHash = deploymentManifestHash(manifest)

  const review = async (persist: boolean) =>
    input.db.$transaction(
      async (tx) => {
        await lockVenueContentMutation(tx, { tenantId: input.tenantId, venueId: input.venueId })
        const venue = await tx.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true, name: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        const base =
          manifest.packageType === 'PATCH'
            ? await tx.venuePackageManifestArtifact.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  packageType: 'FULL',
                  manifestHash: manifest.baseManifestHash,
                },
                select: { id: true },
              })
            : null
        const materialization = reportFor({
          manifest,
          venueId: input.venueId,
          baseFound: manifest.packageType === 'FULL' || Boolean(base),
        })
        const common = {
          scope: { tenantId: input.tenantId, venueId: venue.id, venueName: venue.name },
          artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2' as const,
          manifest,
          canonicalManifest,
          manifestHash,
          evidenceDigest: evidenceDigest(manifest),
          materialization: materialization.report,
          legacyDraftInput: materialization.legacyDraftInput,
        }
        if (!persist) return { ...common, artifact: null, draft: null, replayed: false }

        const existing = await tx.venuePackageManifestArtifact.findFirst({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            idempotencyKey: manifest.idempotencyKey,
          },
        })
        if (existing) {
          if (existing.manifestHash !== manifestHash || existing.createdBy !== input.actor.id) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Manifest request identity collision.',
            })
          }
          return { ...common, artifact: existing, draft: null, replayed: true }
        }
        const artifact = await tx.venuePackageManifestArtifact.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
            manifestSchemaVersion: manifest.schemaVersion,
            packageType: manifest.packageType,
            manifestId: manifest.manifestId,
            idempotencyKey: manifest.idempotencyKey,
            canonicalManifest: JSON.parse(canonicalManifest) as object,
            manifestHash,
            baseManifestHash: manifest.packageType === 'PATCH' ? manifest.baseManifestHash : null,
            evidenceDigest: common.evidenceDigest,
            materializationStatus: materialization.report.status,
            materializationReport: JSON.parse(JSON.stringify(materialization.report)) as object,
            createdBy: input.actor.id,
          },
        })
        return { ...common, artifact, draft: null, replayed: false }
      },
      { isolationLevel: persist ? 'Serializable' : 'RepeatableRead' },
    )

  if (!input.persist) return review(false)

  const preview = await review(false)
  if (preview.materialization.status === 'MATERIALIZABLE' && preview.legacyDraftInput) {
    const materialize = () =>
      createVenuePackageDraftService({
        db: input.db,
        tenantId: input.tenantId,
        actor: input.actor,
        input: preview.legacyDraftInput as never,
        isolationLevel: 'Serializable',
        finalizer: async ({ tx, packageId, replayed }) => {
          let artifact = await tx.venuePackageManifestArtifact.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              idempotencyKey: manifest.idempotencyKey,
            },
            select: artifactSelect,
          })
          if (!artifact) {
            artifact = await tx.venuePackageManifestArtifact.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                artifactKind: 'VENUE_DEPLOYMENT_MANIFEST_V2',
                manifestSchemaVersion: manifest.schemaVersion,
                packageType: manifest.packageType,
                manifestId: manifest.manifestId,
                idempotencyKey: manifest.idempotencyKey,
                canonicalManifest: JSON.parse(canonicalManifest) as object,
                manifestHash,
                baseManifestHash:
                  manifest.packageType === 'PATCH' ? manifest.baseManifestHash : null,
                evidenceDigest: preview.evidenceDigest,
                materializationStatus: preview.materialization.status,
                materializationReport: JSON.parse(
                  JSON.stringify(preview.materialization),
                ) as object,
                createdBy: input.actor.id,
              },
              select: artifactSelect,
            })
          }
          if (artifact.manifestHash !== manifestHash || artifact.createdBy !== input.actor.id) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Manifest request identity collision.',
            })
          }
          const packageLink = await tx.venuePackage.findFirst({
            where: { id: packageId, tenantId: input.tenantId, venueId: input.venueId },
            select: { manifestArtifactId: true, updatedAt: true },
          })
          if (!packageLink) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue package not found.' })
          }
          if (packageLink.manifestArtifactId && packageLink.manifestArtifactId !== artifact.id) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Manifest package link collision.' })
          }
          let linkedUpdatedAt = packageLink.updatedAt
          if (!packageLink.manifestArtifactId) {
            const linkedPackage = await tx.venuePackage.update({
              where: { id: packageId },
              data: { manifestArtifactId: artifact.id },
              select: { updatedAt: true },
            })
            linkedUpdatedAt = linkedPackage.updatedAt
          }
          return { artifact, replayed, linkedUpdatedAt }
        },
      })
    let draftResult: Awaited<ReturnType<typeof materialize>> | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        draftResult = await materialize()
        break
      } catch (error) {
        if ((isUniqueConflict(error) || hasCode(error, 'P2034')) && attempt < 2) continue
        throw error
      }
    }
    if (!draftResult) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Manifest materialization contention.' })
    }
    const attachment = draftResult.attachment as {
      artifact: { id: string; manifestHash: string; createdBy: string }
      replayed: boolean
      linkedUpdatedAt?: Date
    }
    return {
      ...preview,
      artifact: attachment.artifact,
      draft: attachment.linkedUpdatedAt
        ? { ...draftResult.value, updatedAt: attachment.linkedUpdatedAt }
        : draftResult.value,
      replayed: attachment.replayed,
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await review(true)
    } catch (error) {
      if (hasCode(error, 'P2034') && attempt < 2) continue
      if (!isUniqueConflict(error)) throw error
      const converged = await input.db.$transaction(
        (tx) =>
          tx.venuePackageManifestArtifact.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              idempotencyKey: manifest.idempotencyKey,
            },
            select: artifactSelect,
          }),
        { isolationLevel: 'RepeatableRead' },
      )
      if (
        !converged ||
        converged.manifestHash !== manifestHash ||
        converged.createdBy !== input.actor.id
      ) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Manifest request identity collision.' })
      }
      return { ...preview, artifact: converged, draft: null, replayed: true }
    }
  }
  throw new TRPCError({ code: 'CONFLICT', message: 'Manifest persistence contention.' })
}
