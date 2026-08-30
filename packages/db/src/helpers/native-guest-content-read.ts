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

export type NativeGuestReadPreflightBlocker =
  | 'SERVER_GATE_DISABLED'
  | 'VENUE_POLICY_MISSING'
  | 'VENUE_POLICY_DISABLED'
  | 'VENUE_POLICY_INVALID'
  | 'PRODUCTION_APPROVAL_REQUIRED'
  | 'TARGET_RELEASE_NOT_ACTIVE_HEAD'
  | 'NATIVE_HEAD_INVALID'
  | 'EVALUATION_EVIDENCE_INVALID'
  | 'READ_FAILED_CLOSED'

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

export type NativeGuestReadActivationPreflight = {
  contractVersion: 1
  tenantId: string
  venueId: string
  runtime: {
    serverGateEnabled: boolean
    production: boolean
  }
  policy: {
    present: boolean
    enabled: boolean
    valid: boolean
    mode: NativeGuestReadPolicy['mode'] | null
    targetReleaseId: string | null
    evaluationEvidenceId: string | null
    qualityPolicyRef: string | null
    qualityPolicyReferencePresent: boolean
    rollbackRehearsalRef: string | null
    rollbackRehearsalReferencePresent: boolean
    productionApprovalRef: string | null
    productionApprovalReferencePresent: boolean
  }
  head: {
    present: boolean
    valid: boolean
    targetMatches: boolean | null
    releaseId: string | null
  }
  evaluation: {
    valid: boolean
    evidenceId: string | null
  }
  path: NativeGuestReadPath
  reason: NativeGuestReadReason
  readyForConfiguredMode: boolean
  nativeExecutionReady: boolean
  blockers: NativeGuestReadPreflightBlocker[]
  compatibilityDataRetentionRequired: true
  mutationPerformed: false
}

function productionRuntime(environment: Readonly<Record<string, string | undefined>>): boolean {
  if (environment.RAILWAY_ENVIRONMENT)
    return environment.RAILWAY_ENVIRONMENT.toLowerCase() === 'production'
  return environment.NODE_ENV === 'production'
}

type Evaluation = {
  snapshot: Snapshot
  preflight: NativeGuestReadActivationPreflight
}

const emptyPolicy = {
  present: false,
  enabled: false,
  valid: false,
  mode: null,
  targetReleaseId: null,
  evaluationEvidenceId: null,
  qualityPolicyRef: null,
  qualityPolicyReferencePresent: false,
  rollbackRehearsalRef: null,
  rollbackRehearsalReferencePresent: false,
  productionApprovalRef: null,
  productionApprovalReferencePresent: false,
} satisfies NativeGuestReadActivationPreflight['policy']

function result(input: {
  tenantId: string
  venueId: string
  serverGateEnabled: boolean
  production: boolean
  policy?: NativeGuestReadActivationPreflight['policy']
  head?: NativeGuestReadActivationPreflight['head']
  evaluation?: NativeGuestReadActivationPreflight['evaluation']
  snapshot: Snapshot
  blockers: NativeGuestReadPreflightBlocker[]
}): Evaluation {
  return {
    snapshot: input.snapshot,
    preflight: {
      contractVersion: 1,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runtime: {
        serverGateEnabled: input.serverGateEnabled,
        production: input.production,
      },
      policy: input.policy ?? emptyPolicy,
      head: input.head ?? { present: false, valid: false, targetMatches: null, releaseId: null },
      evaluation: input.evaluation ?? { valid: false, evidenceId: null },
      path: input.snapshot.path,
      reason: input.snapshot.reason,
      readyForConfiguredMode: input.snapshot.reason === 'NATIVE_READY',
      nativeExecutionReady: input.snapshot.path === 'NATIVE',
      blockers: input.blockers,
      compatibilityDataRetentionRequired: true,
      mutationPerformed: false,
    },
  }
}

async function evaluateNativeGuestRead(input: {
  client: Client
  tenantId: string
  venueId: string
  environment: Readonly<Record<string, string | undefined>>
  inspectWhenServerDisabled: boolean
}): Promise<Evaluation> {
  const serverGateEnabled = isFeatureEnabled('nativeGuestContentRead', input.environment)
  const production = productionRuntime(input.environment)
  if (!serverGateEnabled && !input.inspectWhenServerDisabled)
    return result({
      ...input,
      serverGateEnabled,
      production,
      snapshot: { path: 'LEGACY', reason: 'SERVER_DISABLED', releaseId: null, state: null },
      blockers: ['SERVER_GATE_DISABLED'],
    })

  try {
    const flag = (await input.client.tenantFeatureFlag.findFirst({
      where: {
        tenantId: input.tenantId,
        flagKey: nativeGuestReadTenantFlagKey(input.venueId),
      },
      select: { enabled: true, metadata: true },
    })) as { enabled: boolean; metadata: unknown } | null
    const parsedPolicy = flag ? NativeGuestReadPolicy.safeParse(flag.metadata) : null
    const policyValue = parsedPolicy?.success ? parsedPolicy.data : null
    const policy = policyValue
      ? {
          present: true,
          enabled: flag?.enabled === true,
          valid: policyValue.venueId === input.venueId,
          mode: policyValue.mode,
          targetReleaseId: policyValue.targetReleaseId,
          evaluationEvidenceId: policyValue.evaluationEvidenceId,
          qualityPolicyRef: policyValue.qualityPolicyRef,
          qualityPolicyReferencePresent: true,
          rollbackRehearsalRef: policyValue.rollbackRehearsalRef,
          rollbackRehearsalReferencePresent: true,
          productionApprovalRef: policyValue.productionApprovalRef,
          productionApprovalReferencePresent: Boolean(policyValue.productionApprovalRef),
        }
      : { ...emptyPolicy, present: Boolean(flag), enabled: flag?.enabled === true }
    const policyValid = policy.valid && policy.enabled

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
    const headValid = Boolean(
      head &&
      head.release.id === head.releaseId &&
      head.release.status === 'APPLIED' &&
      head.artifactId === head.release.artifactId &&
      head.manifestHash === head.release.manifestHash &&
      head.stateHash === head.release.desiredStateHash &&
      stateResult.success &&
      nativeCoreVisibleStateHash(stateResult.data) === head.stateHash,
    )
    const targetMatches = policyValue ? head?.releaseId === policyValue.targetReleaseId : null
    const headSummary = {
      present: Boolean(head),
      valid: headValid,
      targetMatches,
      releaseId: head?.releaseId ?? null,
    }

    let evaluation: { id: string } | null = null
    if (policyValue && head && headValid && targetMatches) {
      evaluation = (await input.client.nativeVenueDeploymentEvaluationEvidence.findFirst({
        where: {
          id: policyValue.evaluationEvidenceId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          releaseId: policyValue.targetReleaseId,
          artifactId: head.artifactId,
          manifestHash: head.manifestHash,
          desiredStateHash: head.stateHash,
          disposition: 'PASS',
        },
        select: { id: true },
      })) as { id: string } | null
    }
    const evaluationSummary = {
      valid: Boolean(evaluation),
      evidenceId: evaluation?.id ?? null,
    }
    const blockers: NativeGuestReadPreflightBlocker[] = []
    if (!serverGateEnabled) blockers.push('SERVER_GATE_DISABLED')
    if (!flag) blockers.push('VENUE_POLICY_MISSING')
    else if (!flag.enabled) blockers.push('VENUE_POLICY_DISABLED')
    if (flag && (!policyValue || policyValue.venueId !== input.venueId))
      blockers.push('VENUE_POLICY_INVALID')
    if (production && policyValue && !policyValue.productionApprovalRef)
      blockers.push('PRODUCTION_APPROVAL_REQUIRED')
    if (!headValid) blockers.push('NATIVE_HEAD_INVALID')
    if (policyValue && !targetMatches) blockers.push('TARGET_RELEASE_NOT_ACTIVE_HEAD')
    if (!evaluation) blockers.push('EVALUATION_EVIDENCE_INVALID')

    let snapshot: Snapshot
    if (!serverGateEnabled)
      snapshot = { path: 'LEGACY', reason: 'SERVER_DISABLED', releaseId: null, state: null }
    else if (!flag || !flag.enabled)
      snapshot = { path: 'LEGACY', reason: 'POLICY_MISSING', releaseId: null, state: null }
    else if (!policyValid || !policyValue)
      snapshot = { path: 'LEGACY', reason: 'POLICY_INVALID', releaseId: null, state: null }
    else if (production && !policyValue.productionApprovalRef)
      snapshot = {
        path: 'LEGACY',
        reason: 'PRODUCTION_APPROVAL_MISSING',
        releaseId: policyValue.targetReleaseId,
        state: null,
      }
    else if (!headValid || !targetMatches || !stateResult.success)
      snapshot = {
        path: 'LEGACY',
        reason: 'HEAD_INVALID',
        releaseId: policyValue.targetReleaseId,
        state: null,
      }
    else if (!evaluation)
      snapshot = {
        path: 'LEGACY',
        reason: 'EVALUATION_INVALID',
        releaseId: policyValue.targetReleaseId,
        state: null,
      }
    else
      snapshot = {
        path: policyValue.mode === 'ACTIVE' ? 'NATIVE' : 'DARK',
        reason: 'NATIVE_READY',
        releaseId: policyValue.targetReleaseId,
        state: stateResult.data,
      }
    return result({
      ...input,
      serverGateEnabled,
      production,
      policy,
      head: headSummary,
      evaluation: evaluationSummary,
      snapshot,
      blockers,
    })
  } catch {
    return result({
      ...input,
      serverGateEnabled,
      production,
      snapshot: { path: 'LEGACY', reason: 'POLICY_INVALID', releaseId: null, state: null },
      blockers: [
        ...(!serverGateEnabled ? (['SERVER_GATE_DISABLED'] as const) : []),
        'READ_FAILED_CLOSED',
      ],
    })
  }
}

/**
 * Produces a complete, read-only diagnostic for one exact tenant/venue scope.
 * Unlike the hot-path resolver it inspects persisted gates even while the
 * server kill switch is disabled, but it never writes or grants authority.
 */
export async function assessNativeGuestReadActivationAction(input: {
  client: Client
  tenantId: string
  venueId: string
  environment?: Readonly<Record<string, string | undefined>>
}): Promise<NativeGuestReadActivationPreflight> {
  return (
    await evaluateNativeGuestRead({
      ...input,
      environment: input.environment ?? process.env,
      inspectWhenServerDisabled: true,
    })
  ).preflight
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
  return (
    await evaluateNativeGuestRead({
      ...input,
      environment,
      inspectWhenServerDisabled: false,
    })
  ).snapshot
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
