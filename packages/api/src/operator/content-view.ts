import type { OperatorDatabase } from './audit'
import { operatorUntrustedText } from './crm-projection'

/**
 * Shared, read-only views of venue content for the operator: legacy places and knowledge, and
 * typed content modules. Every query carries tenant_id and venue_id. Nothing here changes
 * anything, and every text value that came from a source, a customer or a guest is returned as
 * untrusted data.
 */

export const TYPED_RELATIONS = {
  item: true,
  service: true,
  policy: true,
  event: true,
  operationalFact: true,
  relationship: true,
} as const

type Row = Record<string, unknown>
type TypedRelations = Partial<Record<keyof typeof TYPED_RELATIONS, Row | null>>

const METADATA_KEYS = new Set(['revisionId', 'tenantId', 'venueId', 'kind'])
const DATE_KEYS = new Set(['startsAt', 'endsAt', 'expiresAt'])

export type Fields = Record<string, string | null>

function normalizeValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'string') {
    if (DATE_KEYS.has(key)) {
      const parsed = new Date(value)
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    }
    return value
  }
  return JSON.stringify(value)
}

/** The typed payload as flat string fields, so a stored revision and a draft compare directly. */
export function flattenTyped(source: Row): Fields {
  const fields: Fields = {}
  for (const [key, value] of Object.entries(source)) {
    if (METADATA_KEYS.has(key)) continue
    fields[key] = normalizeValue(key, value)
  }
  return fields
}

export function typedFieldsOf(revision: TypedRelations): Fields {
  const relation =
    revision.item ??
    revision.service ??
    revision.policy ??
    revision.event ??
    revision.operationalFact ??
    revision.relationship ??
    null
  return relation ? flattenTyped(relation) : {}
}

export function typedTitleOf(fields: Fields): string {
  return fields.name ?? fields.title ?? fields.label ?? fields.relationshipType ?? '(untitled)'
}

export function untrusted(value: string | null | undefined, max = 500) {
  return operatorUntrustedText(value ?? '', max)
}

export function isoRevision(value: Date): string {
  return value.toISOString()
}

/** Normalizes a caller-supplied legacy revision (an ISO timestamp) so equal instants compare equal. */
export function normalizeLegacyRevision(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

export type PublishedPointer = {
  moduleRevisionId: string
  version: number
  publicationId: string
  audience: 'PUBLIC' | 'CLIENT' | 'OPERATOR'
  effectiveFrom: Date | null
  effectiveUntil: Date | null
}

/** The latest publication event per module, when it is a PUBLISH, with the revision it names. */
export async function readPublishedPointers(
  database: OperatorDatabase,
  scope: { tenantId: string; venueId: string },
  moduleIds: readonly string[],
): Promise<Map<string, PublishedPointer>> {
  const pointers = new Map<string, PublishedPointer>()
  if (moduleIds.length === 0) return pointers
  const latest = await database.contentModulePublication.findMany({
    where: { tenantId: scope.tenantId, venueId: scope.venueId, moduleId: { in: [...moduleIds] } },
    orderBy: [{ moduleId: 'asc' }, { eventOrder: 'desc' }],
    distinct: ['moduleId'],
    select: { id: true, moduleId: true, revisionId: true, action: true },
  })
  const published = latest.filter((event) => event.action === 'PUBLISH')
  if (published.length === 0) return pointers
  const revisions = await database.contentModuleRevision.findMany({
    where: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      id: { in: published.map((event) => event.revisionId) },
    },
    select: { id: true, version: true, audience: true, effectiveFrom: true, effectiveUntil: true },
  })
  const byId = new Map(revisions.map((revision) => [revision.id, revision]))
  for (const event of published) {
    const revision = byId.get(event.revisionId)
    if (!revision) continue
    pointers.set(event.moduleId, {
      moduleRevisionId: revision.id,
      version: revision.version,
      publicationId: event.id,
      audience: revision.audience,
      effectiveFrom: revision.effectiveFrom,
      effectiveUntil: revision.effectiveUntil,
    })
  }
  return pointers
}

/** Whether a published typed revision is served to guests at `now`: public, published, in window. */
export function pointerServesGuests(pointer: PublishedPointer | undefined, now: Date): boolean {
  if (!pointer || pointer.audience !== 'PUBLIC') return false
  if (pointer.effectiveFrom && pointer.effectiveFrom > now) return false
  if (pointer.effectiveUntil && pointer.effectiveUntil <= now) return false
  return true
}

export function typedLifecycle(
  revision: { effectiveFrom: Date | null; effectiveUntil: Date | null },
  now: Date,
): 'ACTIVE' | 'SCHEDULED' | 'ENDED' {
  if (revision.effectiveUntil && revision.effectiveUntil <= now) return 'ENDED'
  if (revision.effectiveFrom && revision.effectiveFrom > now) return 'SCHEDULED'
  return 'ACTIVE'
}

export function legacyAudience(visibility: string): 'PUBLIC' | 'SECOND_LAYER' {
  return visibility === 'PUBLIC' ? 'PUBLIC' : 'SECOND_LAYER'
}
