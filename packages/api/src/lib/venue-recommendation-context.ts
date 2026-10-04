import type { db } from '@pathfinder/db'

import { CatalogHoursInput, VerifiedListInput } from '../schemas/venue-recommendation'
import {
  evaluateRecommendation,
  isRecommendationDecline,
  type CatalogCategory,
  type CatalogItemFacts,
  type CommercialPriority,
  type DietaryState,
  type RecommendationDecision,
  type RecommendationPolicyFacts,
  type RecommendationSessionState,
  type VerifiedList,
} from './venue-recommendation'

type Client = Pick<
  typeof db,
  'venueRecommendationPolicy' | 'venueCatalogItem' | 'venueCatalogItemPriority' | 'analyticsEvent'
>

/** Columns that make up the guest-safe item facts. The priority table is never joined here. */
export const catalogItemFactsSelect = {
  id: true,
  venueId: true,
  version: true,
  category: true,
  name: true,
  description: true,
  placeId: true,
  routeNote: true,
  priceMinor: true,
  currency: true,
  sizeLabel: true,
  priceObservedAt: true,
  effectiveFrom: true,
  effectiveUntil: true,
  availability: true,
  availabilityObservedAt: true,
  hours: true,
  seasonalWindows: true,
  ingredients: true,
  allergens: true,
  dietary: true,
  lastVerifiedAt: true,
  allowedClaims: true,
  archivedAt: true,
} as const

type CatalogItemRow = {
  id: string
  venueId: string
  version: number
  category: string
  name: string
  description: string | null
  placeId: string | null
  routeNote: string | null
  priceMinor: number | null
  currency: string | null
  sizeLabel: string | null
  priceObservedAt: Date | null
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN'
  availabilityObservedAt: Date | null
  hours: unknown
  seasonalWindows: unknown
  ingredients: unknown
  allergens: unknown
  dietary: unknown
  lastVerifiedAt: Date | null
  allowedClaims: string[]
  archivedAt: Date | null
}

const UNKNOWN_LIST: VerifiedList = { status: 'unknown', values: [] }

function verifiedList(value: unknown): VerifiedList {
  const parsed = VerifiedListInput.safeParse(value)
  // Anything unreadable is "unknown", never "none".
  return parsed.success ? parsed.data : UNKNOWN_LIST
}

function seasonalWindows(value: unknown): CatalogItemFacts['seasonalWindows'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) =>
    entry && typeof entry === 'object' && 'start' in entry && 'end' in entry
      ? [{ start: String(entry.start), end: String(entry.end) }]
      : [],
  )
}

function dietary(value: unknown): Record<string, DietaryState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, state]) => [
      key,
      state === 'yes' || state === 'no' ? state : 'unknown',
    ]),
  )
}

export function toCatalogItemFacts(row: CatalogItemRow): CatalogItemFacts {
  const hours = CatalogHoursInput.safeParse(row.hours)
  // `{}` is the stored form of "no serving-hours constraint".
  const noHours =
    row.hours === null ||
    (typeof row.hours === 'object' && Object.keys(row.hours as object).length === 0)
  return {
    id: row.id,
    venueId: row.venueId,
    version: row.version,
    category: row.category as CatalogCategory,
    name: row.name,
    description: row.description,
    placeId: row.placeId,
    routeNote: row.routeNote,
    priceMinor: row.priceMinor,
    currency: row.currency,
    sizeLabel: row.sizeLabel,
    priceObservedAt: row.priceObservedAt,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    availability: row.availability,
    availabilityObservedAt: row.availabilityObservedAt,
    // Hours that were set but cannot be read are treated as closed, not as always open.
    hours: noHours ? null : hours.success ? hours.data : { timeZone: 'UTC', windows: [] },
    seasonalWindows: seasonalWindows(row.seasonalWindows),
    ingredients: verifiedList(row.ingredients),
    allergens: verifiedList(row.allergens),
    dietary: dietary(row.dietary),
    lastVerifiedAt: row.lastVerifiedAt,
    allowedClaims: row.allowedClaims,
    archived: row.archivedAt !== null,
  }
}

const MAX_CATALOG_ITEMS = 100

/**
 * Loads tenant- and venue-scoped state and evaluates the pure decision. Returns null when the
 * capability is off (no enabled policy row), so the guest path is unchanged by default.
 */
export async function buildGuestRecommendationDecision(input: {
  client: Client
  tenantId: string
  venueId: string
  venueName: string
  sessionId: string
  message: string
  priorUserMessages: readonly string[]
  now?: Date
}): Promise<RecommendationDecision | null> {
  const { client, tenantId, venueId } = input
  const policyRow = await client.venueRecommendationPolicy.findFirst({
    where: { tenantId, venueId },
    select: {
      id: true,
      venueId: true,
      version: true,
      enabled: true,
      maxBoost: true,
      maxUnsolicitedPerSession: true,
      factMaxAgeDays: true,
      availabilityMaxAgeHours: true,
      expiresAt: true,
    },
  })
  if (!policyRow || !policyRow.enabled) return null
  const policy: RecommendationPolicyFacts = policyRow

  const [itemRows, priorityRows, events] = await Promise.all([
    client.venueCatalogItem.findMany({
      where: { tenantId, venueId, archivedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_CATALOG_ITEMS,
      select: catalogItemFactsSelect,
    }),
    // OPERATOR-audience data: consumed by the ranking function only, never rendered or logged.
    client.venueCatalogItemPriority.findMany({
      where: { tenantId, venueId, audience: 'OPERATOR' },
      select: { itemId: true, priority: true },
    }),
    client.analyticsEvent.findMany({
      where: {
        tenantId,
        venueId,
        sessionId: input.sessionId,
        eventType: { in: ['recommendation.shown', 'recommendation.declined'] },
      },
      take: 200,
      select: { eventType: true, metadata: true },
    }),
  ])

  const shownItemIds: string[] = []
  let declined = false
  for (const event of events) {
    if (event.eventType === 'recommendation.declined') declined = true
    else if (
      event.metadata &&
      typeof event.metadata === 'object' &&
      !Array.isArray(event.metadata) &&
      typeof (event.metadata as { itemId?: unknown }).itemId === 'string'
    )
      shownItemIds.push((event.metadata as { itemId: string }).itemId)
  }
  const session: RecommendationSessionState = {
    unsolicitedShown: shownItemIds.length,
    shownItemIds,
    // A refusal stated earlier in this session also counts, even if its event was not recorded.
    declined: declined || input.priorUserMessages.some(isRecommendationDecline),
  }
  const priorities: Record<string, CommercialPriority> = Object.fromEntries(
    priorityRows.map((row) => [row.itemId, row.priority]),
  )

  return evaluateRecommendation({
    now: input.now ?? new Date(),
    venueId,
    venueName: input.venueName,
    message: input.message,
    priorUserMessages: input.priorUserMessages,
    items: itemRows.map((row) => toCatalogItemFacts(row)),
    priorities,
    policy,
    session,
  })
}
