import { z } from 'zod'

import {
  deploymentManifestHash,
  VenueDeploymentManifest,
  type DeploymentContentModule,
  type VenueDeploymentPatchManifest,
} from '@pathfinder/contracts/venue-deployment-manifest'
import { TONE_PRESET_TO_LEGACY_AI_TONE } from '@pathfinder/contracts/tone-presets'

import {
  VenuePackageDraftInput,
  VenuePackagePayloadV3,
  VenuePackagePreviewInput,
  type VenuePackagePayloadV3 as VenuePackagePayloadV3Type,
  type VenuePackageSourceProvenance,
} from '../schemas/venue-package'

export type DeploymentManifestBridgeIssue = {
  severity: 'ERROR' | 'WARNING'
  code: string
  path: string
  message: string
}

export type DeploymentManifestBridgePreview = {
  compatible: boolean
  manifestHash: string | null
  manifest: z.infer<typeof VenueDeploymentManifest> | null
  issues: readonly DeploymentManifestBridgeIssue[]
  payload: VenuePackagePayloadV3Type | null
  handoff: {
    previewProcedure: 'venuePackage.preview'
    draftProcedure: 'venuePackage.createDraft'
    approvalProcedure: 'venuePackage.approve'
    applyProcedure: 'venuePackage.applyPackage'
    rollbackProcedure: 'venuePackage.revertPackage'
  }
}

const HANDOFF = {
  previewProcedure: 'venuePackage.preview',
  draftProcedure: 'venuePackage.createDraft',
  approvalProcedure: 'venuePackage.approve',
  applyProcedure: 'venuePackage.applyPackage',
  rollbackProcedure: 'venuePackage.revertPackage',
} as const

function sourceProvenance(manifest: VenueDeploymentPatchManifest): VenuePackageSourceProvenance {
  return {
    sourceType: 'deployment-manifest-v2',
    sourceName: manifest.manifestId,
    contentOrigin:
      manifest.provenance.createdBy.kind === 'SYSTEM' ? 'AI_GENERATED' : 'HUMAN_AUTHORED',
  }
}

function contentCategory(module: Extract<DeploymentContentModule, { kind: 'KNOWLEDGE' }>) {
  return module.topics[0]?.slice(0, 100) || 'General'
}

function placeCreate(module: Extract<DeploymentContentModule, { kind: 'PLACE' }>) {
  return {
    name: module.name,
    type: 'place',
    itemType: 'physical_place' as const,
    ...(module.description ? { shortDescription: module.description.slice(0, 500) } : {}),
    ...(module.description ? { longDescription: module.description.slice(0, 2_000) } : {}),
    tags: module.accessibility.map((item) => `accessibility:${item}`),
    importanceScore: 0,
  }
}

function placeUpdate(module: Extract<DeploymentContentModule, { kind: 'PLACE' }>) {
  return {
    name: module.name,
    type: 'place',
    itemType: 'physical_place',
    shortDescription: module.description?.slice(0, 500) ?? null,
    longDescription: module.description?.slice(0, 2_000) ?? null,
    lat: null,
    lng: null,
    tags: module.accessibility.map((item) => `accessibility:${item}`),
    importanceScore: 0,
    areaName: null,
    hours: null,
    photoUrl: null,
    isActive: true,
  }
}

function emptyPayload(): VenuePackagePayloadV3Type {
  return {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: { create: [], update: [], delete: [] },
  }
}

function addIssue(
  issues: DeploymentManifestBridgeIssue[],
  severity: DeploymentManifestBridgeIssue['severity'],
  code: string,
  path: string,
  message: string,
) {
  issues.push({ severity, code, path, message })
}

function assignVenuePatch(
  payload: VenuePackagePayloadV3Type,
  section: 'identity' | 'branding' | 'aiBehavior',
  value: Record<string, unknown>,
) {
  const venue = payload.venue ?? {}
  payload.venue = {
    ...venue,
    [section]: { ...(venue[section] ?? {}), ...value },
  } as NonNullable<VenuePackagePayloadV3Type['venue']>
}

export function previewDeploymentManifestConversion(input: {
  venueId: string
  manifest: unknown
}): DeploymentManifestBridgePreview {
  const parsed = VenueDeploymentManifest.safeParse(input.manifest)
  if (!parsed.success) {
    return {
      compatible: false,
      manifestHash: null,
      manifest: null,
      issues: parsed.error.issues.map((issue) => ({
        severity: 'ERROR' as const,
        code: 'INVALID_MANIFEST',
        path: issue.path.join('.'),
        message: issue.message,
      })),
      payload: null,
      handoff: HANDOFF,
    }
  }
  const manifest = parsed.data
  const manifestHash = deploymentManifestHash(manifest)
  const issues: DeploymentManifestBridgeIssue[] = []
  if (manifest.venueRef !== input.venueId) {
    addIssue(
      issues,
      'ERROR',
      'VENUE_SCOPE_MISMATCH',
      'venueRef',
      'Manifest venueRef must exactly match the venue selected for the existing lifecycle.',
    )
  }
  if (manifest.packageType !== 'PATCH') {
    addIssue(
      issues,
      'ERROR',
      'FULL_NOT_CONVERTIBLE',
      'packageType',
      'FULL manifests require a future materialization service; this bridge accepts granular PATCH manifests only.',
    )
    return { compatible: false, manifestHash, manifest, issues, payload: null, handoff: HANDOFF }
  }

  const payload = emptyPayload()
  const provenance = sourceProvenance(manifest)
  const targets = new Set<string>()
  addIssue(
    issues,
    'WARNING',
    'BASE_HASH_DELEGATED',
    'baseManifestHash',
    'The existing VenuePackage preview base digest and stale-approval guard remain authoritative; no persisted v2 manifest hash exists to compare locally.',
  )
  if (manifest.provenance.evidenceIds.length > 0) {
    addIssue(
      issues,
      'WARNING',
      'EVIDENCE_METADATA_NOT_PERSISTED',
      'provenance.evidenceIds',
      'The existing VenuePackage row does not retain v2 evidence IDs; callers must retain the validated manifest alongside the draft reference.',
    )
  }

  manifest.operations.forEach((operation, index) => {
    const path = `operations.${index}`
    let target: string = operation.op
    if ('moduleId' in operation)
      target = `${operation.op}:${operation.moduleKind}:${operation.moduleId}`
    if (operation.op === 'RESET_CONTENT_FIELD') target = `${target}:${operation.field}`
    if (operation.op === 'UPSERT_CONTENT_MODULE')
      target = `${operation.op}:${operation.value.kind}:${operation.value.id}`
    if (operation.op === 'SET_CAPABILITY') target = `${operation.op}:${operation.capabilityId}`
    if (operation.op === 'SET_EFFECTIVE_CONFIG_PROVENANCE')
      target = `${operation.op}:${operation.value.key}`
    if (operation.op === 'RETIRE_EFFECTIVE_CONFIG_PROVENANCE')
      target = `${operation.op}:${operation.key}`
    if (operation.op === 'RESET_CONFIGURATION') target = `${operation.op}:${operation.path}`
    if (operation.op === 'UPSERT_ASSET') target = `${operation.op}:${operation.value.assetId}`
    if (operation.op === 'RETIRE_ASSET') target = `${operation.op}:${operation.assetId}`
    if (targets.has(target)) {
      addIssue(issues, 'ERROR', 'AMBIGUOUS_TARGET', path, `Multiple operations target ${target}.`)
      return
    }
    targets.add(target)

    switch (operation.op) {
      case 'UPSERT_IDENTITY':
        if ((operation.value.description?.length ?? 0) > 1_000) {
          addIssue(
            issues,
            'ERROR',
            'LEGACY_FIELD_LIMIT',
            `${path}.value.description`,
            'Existing venue identity descriptions are limited to 1,000 characters.',
          )
          return
        }
        assignVenuePatch(payload, 'identity', {
          name: operation.value.name,
          ...(operation.value.description !== undefined
            ? { description: operation.value.description }
            : {}),
        })
        break
      case 'UPSERT_BRANDING':
        if (operation.value.logoAssetId || operation.value.bannerAssetId) {
          addIssue(
            issues,
            'ERROR',
            'IMMUTABLE_ASSET_NOT_SUPPORTED',
            `${path}.value`,
            'Existing branding persistence accepts URLs, not immutable v2 asset references.',
          )
        }
        assignVenuePatch(payload, 'branding', {
          chatTheme: operation.value.themeId,
          chatAccentColor: operation.value.accentColor ?? null,
          chatFont: operation.value.fontId,
        })
        break
      case 'UPSERT_AI_CONFIGURATION':
        if (operation.value.modelReferences.length > 0) {
          addIssue(
            issues,
            'ERROR',
            'MODEL_REFERENCE_NOT_SUPPORTED',
            `${path}.value.modelReferences`,
            'Existing VenuePackage persistence does not store per-venue model references.',
          )
        }
        assignVenuePatch(payload, 'aiBehavior', {
          ...(operation.value.guideName !== undefined
            ? { aiGuideName: operation.value.guideName }
            : {}),
          tonePreset: operation.value.tone.preset,
          aiTone: TONE_PRESET_TO_LEGACY_AI_TONE[operation.value.tone.preset],
        })
        break
      case 'UPSERT_CONTENT_MODULE': {
        const module = operation.value
        if (module.audience !== 'PUBLIC') {
          addIssue(
            issues,
            'ERROR',
            'AUDIENCE_NOT_SUPPORTED',
            `${path}.value.audience`,
            'Existing VenuePackage content is public and cannot preserve restricted audiences.',
          )
        }
        if (module.evidence.length > 0) {
          addIssue(
            issues,
            'WARNING',
            'MODULE_EVIDENCE_NOT_PERSISTED',
            `${path}.value.evidence`,
            'Existing VenuePackage provenance cannot retain granular module evidence references.',
          )
        }
        addIssue(
          issues,
          'WARNING',
          'MODULE_VERSION_DELEGATED',
          `${path}.value.version`,
          'Existing content history, not the manifest module version, remains authoritative.',
        )
        if (module.assetIds.length > 0) {
          addIssue(
            issues,
            'ERROR',
            'CONTENT_ASSET_NOT_SUPPORTED',
            `${path}.value.assetIds`,
            'Existing granular content persistence cannot retain immutable module asset references.',
          )
        }
        if (module.kind !== 'PLACE' && module.kind !== 'KNOWLEDGE') {
          addIssue(
            issues,
            'ERROR',
            'MODULE_KIND_NOT_SUPPORTED',
            `${path}.value.kind`,
            `Existing VenuePackage v3 cannot persist ${module.kind} modules.`,
          )
          return
        }
        const existingId = z.string().cuid().safeParse(module.id)
        if (module.kind === 'PLACE') {
          if (module.parentId) {
            addIssue(
              issues,
              'ERROR',
              'PLACE_PARENT_NOT_SUPPORTED',
              `${path}.value.parentId`,
              'Existing Place persistence cannot retain the v2 parent stable ID.',
            )
          }
          if ((module.description?.length ?? 0) > 2_000) {
            addIssue(
              issues,
              'ERROR',
              'LEGACY_FIELD_LIMIT',
              `${path}.value.description`,
              'Existing place descriptions are limited to 2,000 characters.',
            )
            return
          }
          if (existingId.success) {
            payload.places.update.push({
              itemKey: operation.operationId,
              provenance,
              id: existingId.data,
              value: placeUpdate(module),
            })
          } else {
            payload.places.create.push({
              itemKey: operation.operationId,
              provenance,
              value: placeCreate(module),
            })
          }
        } else {
          if (module.body.length > 5_000) {
            addIssue(
              issues,
              'ERROR',
              'LEGACY_FIELD_LIMIT',
              `${path}.value.body`,
              'Existing knowledge entries are limited to 5,000 characters.',
            )
            return
          }
          const value = {
            title: module.title,
            category: contentCategory(module),
            content: module.body,
            isEnabled: true,
          }
          if (existingId.success)
            payload.knowledgeEntries.update.push({
              itemKey: operation.operationId,
              provenance,
              id: existingId.data,
              value,
            })
          else
            payload.knowledgeEntries.create.push({
              itemKey: operation.operationId,
              provenance,
              value,
            })
        }
        break
      }
      case 'RETIRE_CONTENT_MODULE': {
        if (operation.expectedVersion !== undefined) {
          addIssue(
            issues,
            'WARNING',
            'MODULE_VERSION_DELEGATED',
            `${path}.expectedVersion`,
            'Existing content history and preview stale checks, not the manifest version, remain authoritative.',
          )
        }
        if (operation.moduleKind !== 'PLACE' && operation.moduleKind !== 'KNOWLEDGE') {
          addIssue(
            issues,
            'ERROR',
            'MODULE_KIND_NOT_SUPPORTED',
            `${path}.moduleKind`,
            `Existing VenuePackage v3 cannot retire ${operation.moduleKind} modules.`,
          )
          return
        }
        const existingId = z.string().cuid().safeParse(operation.moduleId)
        if (!existingId.success) {
          addIssue(
            issues,
            'ERROR',
            'PERSISTED_ID_REQUIRED',
            `${path}.moduleId`,
            'Retirement requires the existing persisted CUID; stable draft-only IDs cannot target stored content.',
          )
          return
        }
        const value = { itemKey: operation.operationId, provenance, id: existingId.data }
        if (operation.moduleKind === 'PLACE') payload.places.delete.push(value)
        else payload.knowledgeEntries.delete.push(value)
        break
      }
      case 'RESET_CONFIGURATION':
        if (operation.path === 'identity.description')
          assignVenuePatch(payload, 'identity', { description: null })
        else if (operation.path === 'branding.accentColor')
          assignVenuePatch(payload, 'branding', { chatAccentColor: null })
        else if (operation.path === 'branding.logoAssetId')
          assignVenuePatch(payload, 'branding', { chatLogoUrl: null })
        else if (operation.path === 'branding.bannerAssetId')
          assignVenuePatch(payload, 'branding', { chatBannerUrl: null })
        else if (operation.path === 'aiConfiguration.guideName')
          assignVenuePatch(payload, 'aiBehavior', { aiGuideName: null })
        else
          addIssue(
            issues,
            'ERROR',
            'RESET_NOT_SUPPORTED',
            `${path}.path`,
            `Existing VenuePackage v3 cannot safely reset ${operation.path}.`,
          )
        break
      case 'RESET_CONTENT_FIELD':
      case 'SET_CAPABILITY':
      case 'SET_PRESET':
      case 'SET_EFFECTIVE_CONFIG_PROVENANCE':
      case 'RETIRE_EFFECTIVE_CONFIG_PROVENANCE':
      case 'UPSERT_ASSET':
      case 'RETIRE_ASSET':
      case 'SET_EVALUATION_REFERENCES':
        addIssue(
          issues,
          'ERROR',
          'OPERATION_NOT_SUPPORTED',
          path,
          `${operation.op} has no lossless mapping to existing VenuePackage v3 persistence.`,
        )
        break
    }
  })

  const errors = issues.some((issue) => issue.severity === 'ERROR')
  const payloadResult = errors ? null : VenuePackagePayloadV3.safeParse(payload)
  if (payloadResult && !payloadResult.success) {
    payloadResult.error.issues.forEach((issue) =>
      addIssue(issues, 'ERROR', 'INVALID_V3_HANDOFF', issue.path.join('.'), issue.message),
    )
  }
  const finalPayload = payloadResult?.success ? payloadResult.data : null
  return {
    compatible: finalPayload !== null,
    manifestHash,
    manifest,
    issues,
    payload: finalPayload,
    handoff: HANDOFF,
  }
}

export function deploymentManifestPreviewInput(input: { venueId: string; manifest: unknown }) {
  const converted = previewDeploymentManifestConversion(input)
  if (!converted.payload) return { converted, previewInput: null }
  return {
    converted,
    previewInput: VenuePackagePreviewInput.parse({
      venueId: input.venueId,
      payload: converted.payload,
    }),
  }
}

export function deploymentManifestDraftInput(input: { venueId: string; manifest: unknown }) {
  const converted = previewDeploymentManifestConversion(input)
  if (!converted.payload || converted.manifest?.packageType !== 'PATCH') {
    return { converted, draftInput: null }
  }
  return {
    converted,
    draftInput: VenuePackageDraftInput.parse({
      venueId: input.venueId,
      payload: converted.payload,
      draftKey: converted.manifest.idempotencyKey,
    }),
  }
}
