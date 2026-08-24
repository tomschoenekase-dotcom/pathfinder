import {
  NativeCoreVisibleState,
  NativeGuestReadPolicy,
  nativeCoreVisibleStateHash,
  type NativeCoreVisibleState as NativeState,
} from '@pathfinder/contracts'
import { isFeatureEnabled, nativeGuestReadTenantFlagKey } from '@pathfinder/config/feature-flags'

import type { SemanticKnowledgeEntry, SemanticPlace } from './semantic-search'

export type NativeGuestReadPath = 'LEGACY' | 'DARK' | 'NATIVE'
export type NativeGuestReadReason =
  | 'SERVER_DISABLED'
  | 'POLICY_MISSING'
  | 'POLICY_INVALID'
  | 'PRODUCTION_APPROVAL_MISSING'
  | 'HEAD_INVALID'
  | 'EVALUATION_INVALID'
  | 'NATIVE_READY'

type Client = {
  tenantFeatureFlag: { findFirst(args: unknown): Promise<unknown> }
  nativeVenueDeploymentHead: { findFirst(args: unknown): Promise<unknown> }
  nativeVenueDeploymentEvaluationEvidence: { findFirst(args: unknown): Promise<unknown> }
}

type Snapshot = {
  path: NativeGuestReadPath
  reason: NativeGuestReadReason
  releaseId: string | null
  state: NativeState | null
}

function productionRuntime(environment: Readonly<Record<string, string | undefined>>): boolean {
  if (environment.RAILWAY_ENVIRONMENT)
    return environment.RAILWAY_ENVIRONMENT.toLowerCase() === 'production'
  return environment.NODE_ENV === 'production'
}

/**
 * Resolves, but never mutates, one venue's native-read capability. Every error
 * fails closed to the compatibility path. ACTIVE is impossible without both
 * server and venue gates plus exact immutable release/evaluation evidence.
 */
export async function resolveNativeGuestReadSnapshotAction(input: {
  client: Client
  tenantId: string
  venueId: string
  environment?: Readonly<Record<string, string | undefined>>
}): Promise<Snapshot> {
  const environment = input.environment ?? process.env
  if (!isFeatureEnabled('nativeGuestContentRead', environment))
    return { path: 'LEGACY', reason: 'SERVER_DISABLED', releaseId: null, state: null }

  try {
    const flag = (await input.client.tenantFeatureFlag.findFirst({
      where: {
        tenantId: input.tenantId,
        flagKey: nativeGuestReadTenantFlagKey(input.venueId),
        enabled: true,
      },
      select: { metadata: true },
    })) as { metadata: unknown } | null
    if (!flag) return { path: 'LEGACY', reason: 'POLICY_MISSING', releaseId: null, state: null }
    const parsedPolicy = NativeGuestReadPolicy.safeParse(flag.metadata)
    if (!parsedPolicy.success || parsedPolicy.data.venueId !== input.venueId)
      return { path: 'LEGACY', reason: 'POLICY_INVALID', releaseId: null, state: null }
    const policy = parsedPolicy.data
    if (productionRuntime(environment) && !policy.productionApprovalRef)
      return {
        path: 'LEGACY',
        reason: 'PRODUCTION_APPROVAL_MISSING',
        releaseId: policy.targetReleaseId,
        state: null,
      }

    const head = (await input.client.nativeVenueDeploymentHead.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId },
      select: {
        releaseId: true,
        artifactId: true,
        manifestHash: true,
        stateHash: true,
        release: {
          select: {
            id: true,
            artifactId: true,
            manifestHash: true,
            desiredStateHash: true,
            status: true,
            plan: true,
          },
        },
      },
    })) as {
      releaseId: string
      artifactId: string
      manifestHash: string
      stateHash: string
      release: {
        id: string
        artifactId: string
        manifestHash: string
        desiredStateHash: string
        status: string
        plan: unknown
      }
    } | null
    const plan = head?.release.plan as { desired?: unknown } | undefined
    const stateResult = NativeCoreVisibleState.safeParse(plan?.desired)
    if (
      !head ||
      head.releaseId !== policy.targetReleaseId ||
      head.release.id !== head.releaseId ||
      head.release.status !== 'APPLIED' ||
      head.artifactId !== head.release.artifactId ||
      head.manifestHash !== head.release.manifestHash ||
      head.stateHash !== head.release.desiredStateHash ||
      !stateResult.success ||
      nativeCoreVisibleStateHash(stateResult.data) !== head.stateHash
    )
      return {
        path: 'LEGACY',
        reason: 'HEAD_INVALID',
        releaseId: policy.targetReleaseId,
        state: null,
      }

    const evaluation = (await input.client.nativeVenueDeploymentEvaluationEvidence.findFirst({
      where: {
        id: policy.evaluationEvidenceId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        releaseId: policy.targetReleaseId,
        artifactId: head.artifactId,
        manifestHash: head.manifestHash,
        desiredStateHash: head.stateHash,
        disposition: 'PASS',
      },
      select: { id: true },
    })) as { id: string } | null
    if (!evaluation)
      return {
        path: 'LEGACY',
        reason: 'EVALUATION_INVALID',
        releaseId: policy.targetReleaseId,
        state: null,
      }
    return {
      path: policy.mode === 'ACTIVE' ? 'NATIVE' : 'DARK',
      reason: 'NATIVE_READY',
      releaseId: policy.targetReleaseId,
      state: stateResult.data,
    }
  } catch {
    return { path: 'LEGACY', reason: 'POLICY_INVALID', releaseId: null, state: null }
  }
}

/**
 * Compatibility results remain the authorization/ranking index. Native values
 * may replace them only when every authorized ID exists in the exact snapshot;
 * otherwise the whole collection remains legacy (no mixed-source response).
 */
export function applyNativeGuestContentRead(input: {
  snapshot: Snapshot
  legacyPlaces: SemanticPlace[]
  legacyKnowledgeEntries: SemanticKnowledgeEntry[]
}): {
  path: NativeGuestReadPath
  places: SemanticPlace[]
  knowledgeEntries: SemanticKnowledgeEntry[]
} {
  if (input.snapshot.path !== 'NATIVE' || !input.snapshot.state)
    return {
      path: input.snapshot.path,
      places: input.legacyPlaces,
      knowledgeEntries: input.legacyKnowledgeEntries,
    }
  const places = new Map(input.snapshot.state.places.map((item) => [item.id, item]))
  const knowledge = new Map(input.snapshot.state.knowledgeEntries.map((item) => [item.id, item]))
  if (
    input.legacyPlaces.some((item) => !places.has(item.id)) ||
    input.legacyKnowledgeEntries.some((item) => !knowledge.has(item.id))
  )
    return {
      path: 'LEGACY',
      places: input.legacyPlaces,
      knowledgeEntries: input.legacyKnowledgeEntries,
    }
  return {
    path: 'NATIVE',
    places: input.legacyPlaces.map((legacy) => {
      const native = places.get(legacy.id)!
      return {
        id: native.id,
        name: native.name,
        type: native.type,
        itemType: native.itemType,
        shortDescription: native.shortDescription,
        longDescription: native.longDescription,
        lat: native.lat,
        lng: native.lng,
        tags: native.tags,
        areaName: native.areaName,
        hours: native.hours,
        photoUrl: native.photoUrl,
        sourceType: native.sourceType,
        sourceName: native.sourceName,
        sourceUrl: native.sourceUrl,
        ...(legacy.distance === undefined ? {} : { distance: legacy.distance }),
        ...(legacy.distanceMeters === undefined ? {} : { distanceMeters: legacy.distanceMeters }),
      }
    }),
    knowledgeEntries: input.legacyKnowledgeEntries.map((legacy) => {
      const native = knowledge.get(legacy.id)!
      return {
        id: native.id,
        title: native.title,
        category: native.category,
        content: native.content,
        sourceType: native.sourceType,
        sourceName: native.sourceName,
        sourceUrl: native.sourceUrl,
        distance: legacy.distance,
      }
    }),
  }
}
