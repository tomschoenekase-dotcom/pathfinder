import {
  AI_CENTRAL_MODEL_REGISTRY,
  AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS,
  getAiModelSpec,
  type AiEffectiveWorkloadConfiguration,
  type AiWorkloadId,
} from '@pathfinder/ai'
import {
  OPERATOR_GUEST_MODEL_KEYS,
  type OperatorGuestModelKey,
} from '@pathfinder/contracts/operator-mcp'
import {
  configurationValuesFromRow,
  guestChatDeploymentDefaultModelKey,
  resolveRuntimeAiWorkloadConfiguration,
} from '@pathfinder/db'

import { providerHasExecutionKey } from '../routers/admin/ai-provider-connections'
import type { OperatorDatabase } from './audit'

/**
 * Venue-scoped visitor chat model selection for the operator. The stored override and its
 * resolution are the same ones the admin dashboard uses (packages/db ai-workload-configuration-
 * actions); this module only adds the operator's allowlist, wording and read projection.
 */

export const GUEST_CHAT_WORKLOAD = 'guest-chat' as const

// Every operator choice must be a governed public visitor route. This fails to compile otherwise.
const _allowlistIsGoverned: readonly (typeof AI_PUBLIC_VISITOR_CHAT_ROUTE_KEYS)[number][] =
  OPERATOR_GUEST_MODEL_KEYS
void _allowlistIsGoverned

export const GUEST_MODEL_CHOICES: Readonly<
  Record<OperatorGuestModelKey, { title: string; description: string; recommended: boolean }>
> = {
  'guest-chat-sol-fast': {
    title: 'Sol + Fast',
    description:
      'Recommended default. Best graded accuracy in testing, with low and steady time to first text. Billed at twice the standard Sol rate.',
    recommended: true,
  },
  'guest-chat-terra-fast': {
    title: 'Terra + Fast',
    description:
      'About twice as fast and cheaper than Sol + Fast, but it omitted more needed details (conditions, hours) in testing. Only when speed matters more than completeness.',
    recommended: false,
  },
  'guest-chat-sol': {
    title: 'Sol (standard speed)',
    description:
      'Same model and accuracy as Sol + Fast at half the price, with slower and less steady first text.',
    recommended: false,
  },
  'guest-chat-luna': {
    title: 'Luna',
    description:
      'Smaller, cheaper OpenAI model. Weaker on long or conditional answers; use only for a measured cost reason.',
    recommended: false,
  },
  'guest-chat-luna-reasoning': {
    title: 'Luna + brief reasoning',
    description:
      'Luna that reasons briefly before answering. Cheaper than Sol, with slower first text.',
    recommended: false,
  },
  'guest-chat': {
    title: 'Platform built-in (Haiku)',
    description:
      'The registry fallback route on Anthropic Haiku. Economy tier and not the measured choice for current guides.',
    recommended: false,
  },
}

export const GUEST_MODEL_GUIDANCE =
  'Use guest-chat-sol-fast (Sol + Fast) unless a measured test on this venue shows a better choice. Terra + Fast is faster but omitted more needed details in testing. Never pick a slower or larger model just because it is bigger.'

export const guestModelOverrideSelect = {
  id: true,
  workloadId: true,
  enabled: true,
  primaryModelKey: true,
  primaryModelKeySet: true,
  fallbackEnabled: true,
  fallbackEnabledSet: true,
  fallbackModelKeys: true,
  fallbackModelKeysSet: true,
  timeoutMs: true,
  timeoutMsSet: true,
  maxAttempts: true,
  maxAttemptsSet: true,
  maxOutputTokens: true,
  maxOutputTokensSet: true,
  requestBudgetCeilingE8Usd: true,
  requestBudgetCeilingE8UsdSet: true,
  unsafeChangesEnabled: true,
  isTombstone: true,
  reason: true,
  revision: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
} as const

export type GuestModelOverrideRow = Parameters<typeof configurationValuesFromRow>[0]

/** The venue's own guest-chat override row (live or reset), always under its tenant. */
export async function readVenueGuestModelOverride(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
): Promise<GuestModelOverrideRow | null> {
  return (await database.aiScopedWorkloadConfigurationOverride.findFirst({
    where: { tenantId, venueScopeKey: venueId, workloadId: GUEST_CHAT_WORKLOAD },
    select: guestModelOverrideSelect,
  })) as GuestModelOverrideRow | null
}

/** Stored values on a live row; a reset (tombstone) row carries none. */
export function liveOverrideValues(row: GuestModelOverrideRow | null) {
  return row && !row.isTombstone ? configurationValuesFromRow(row) : {}
}

export function otherOverrideSettings(row: GuestModelOverrideRow | null): string[] {
  return Object.keys(liveOverrideValues(row)).filter((key) => key !== 'primaryModelKey')
}

export function guestModelVersion(revision: number | null | undefined): string {
  return revision === null || revision === undefined ? 'none' : `revision:${revision}`
}

export function guestModelAvailable(modelKey: AiWorkloadId): boolean {
  return providerHasExecutionKey(AI_CENTRAL_MODEL_REGISTRY[modelKey].provider)
}

type EffectiveSource =
  | 'PLATFORM_DEFAULT'
  | 'DEPLOYMENT_DEFAULT'
  | 'WORKLOAD_OVERRIDE'
  | 'CLIENT_OVERRIDE'
  | 'VENUE_OVERRIDE'

function describeSource(
  effective: AiEffectiveWorkloadConfiguration,
  deploymentDefault: string | undefined,
): { source: EffectiveSource; sourceDetail: string } {
  switch (effective.sources.primaryModelKey) {
    case 'VENUE':
      return { source: 'VENUE_OVERRIDE', sourceDetail: 'Set for this venue only.' }
    case 'CLIENT':
      return {
        source: 'CLIENT_OVERRIDE',
        sourceDetail: 'Set for every venue of this client; a venue override would replace it here.',
      }
    case 'WORKLOAD':
      return {
        source: 'WORKLOAD_OVERRIDE',
        sourceDetail: 'Set platform-wide for visitor chat in the admin dashboard.',
      }
    default:
      return deploymentDefault
        ? {
            source: 'DEPLOYMENT_DEFAULT',
            sourceDetail: 'This deployment default comes from GUEST_CHAT_DEFAULT_MODEL_KEY.',
          }
        : { source: 'PLATFORM_DEFAULT', sourceDetail: 'The built-in registry default.' }
  }
}

export async function readGuestModelState(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
) {
  const [effective, row] = await Promise.all([
    resolveRuntimeAiWorkloadConfiguration(
      { workloadId: GUEST_CHAT_WORKLOAD, tenantId, venueId },
      database,
    ),
    readVenueGuestModelOverride(database, tenantId, venueId),
  ])
  return { effective, row }
}

export async function guestModelView(
  database: OperatorDatabase,
  tenantId: string,
  venueId: string,
) {
  const { effective, row } = await readGuestModelState(database, tenantId, venueId)
  const deploymentDefault = guestChatDeploymentDefaultModelKey()
  const values = liveOverrideValues(row)
  // Embedding keys have no text spec; visitor chat never resolves to one.
  const spec = getAiModelSpec(effective.primaryModelKey as never) as
    | ReturnType<typeof getAiModelSpec>
    | undefined
  return {
    tenantId,
    venueId,
    workloadId: GUEST_CHAT_WORKLOAD,
    effective: {
      modelKey: effective.primaryModelKey,
      provider: effective.model.provider,
      model: effective.model.model,
      fastMode: spec?.serviceTier === 'fast',
      ...describeSource(effective, deploymentDefault),
    },
    deploymentDefaultModelKey: deploymentDefault ?? null,
    venueOverride: row
      ? {
          active: row.enabled && !row.isTombstone,
          modelKey: values.primaryModelKey ?? null,
          otherSettings: otherOverrideSettings(row),
          revision: row.revision,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
    choices: OPERATOR_GUEST_MODEL_KEYS.map((modelKey) => ({
      modelKey,
      ...GUEST_MODEL_CHOICES[modelKey],
      available: guestModelAvailable(modelKey),
      current: effective.primaryModelKey === modelKey,
    })),
    guidance: GUEST_MODEL_GUIDANCE,
  }
}
