import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { db } from '../client'

export const SALES_PREPARATION_SOURCE = 'CRM_SALES_PREPARATION_V1'
export type SalesClient = typeof db
export type SalesTransaction = Parameters<Parameters<SalesClient['$transaction']>[0]>[0]
type ReadClient = Pick<
  SalesClient,
  'prospectVenue' | 'prospectContact' | 'prospectImportSourceRecord'
>
type Serialized<T> = T extends Date
  ? string
  : T extends readonly (infer V)[]
    ? Serialized<V>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T

export function salesJson<T>(value: T): Serialized<T> {
  return JSON.parse(JSON.stringify(value)) as Serialized<T>
}

/** Stable key order; Date values have already been converted to exact ISO strings. */
export function salesHash(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      )
    return v
  }
  return createHash('sha256')
    .update(JSON.stringify(sort(value)))
    .digest('hex')
}

export class ProspectSalesError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'SUPPRESSED' | 'INVALID_INPUT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectSalesError'
  }
}

/** Read the native contactability projection, not a second suppression ledger. */
export function nativeContactHeld(contact: {
  doNotContact: boolean
  permissionState: string
  suppressedAt: unknown
  unsubscribedAt: unknown
  complainedAt: unknown
  lastHardBounceAt: unknown
}): boolean {
  return (
    contact.doNotContact ||
    ['OPTED_OUT', 'PROHIBITED'].includes(contact.permissionState) ||
    Boolean(
      contact.suppressedAt ||
      contact.unsubscribedAt ||
      contact.complainedAt ||
      contact.lastHardBounceAt,
    )
  )
}

const nativeHoldConditions: Prisma.ProspectContactWhereInput[] = [
  { doNotContact: true },
  { permissionState: { in: ['OPTED_OUT', 'PROHIBITED'] } },
  { suppressedAt: { not: null } },
  { unsubscribedAt: { not: null } },
  { complainedAt: { not: null } },
  { lastHardBounceAt: { not: null } },
]

/** Reuse the native address-wide contactability projection, even when a retained
 * public routing snapshot differs from the workbook's candidate email. */
export async function readNativeSalesRouteSuppression(
  route: unknown,
  client: Pick<SalesClient, 'prospectContact'> = db,
) {
  const value = route && typeof route === 'object' ? (route as Record<string, unknown>) : {}
  const email =
    value.kind === 'email' && typeof value.recipient === 'string'
      ? value.recipient.trim().toLowerCase()
      : null
  if (!email) return { blocked: false, reasons: [] as string[] }
  const holds = await client.prospectContact.findMany({
    where: { normalizedEmail: email, OR: nativeHoldConditions },
    orderBy: { id: 'asc' },
    take: 65,
    select: { id: true },
  })
  return {
    blocked: holds.length > 0,
    reasons: holds.map((contact) => `Native public-route address hold: ${contact.id}`),
  }
}

export async function requireNativeSalesRouteClear(
  route: unknown,
  client: Pick<SalesClient, 'prospectContact'> = db,
) {
  const holds = await readNativeSalesRouteSuppression(route, client)
  if (holds.blocked)
    throw new ProspectSalesError(
      'SUPPRESSED',
      'Native public-route suppression blocks this preparation; no alternate route is selected',
    )
}

export async function readNativeSalesSnapshot(venueId: string, client: ReadClient = db) {
  const value = await client.prospectVenue.findUnique({
    where: { id: venueId },
    include: {
      organization: { include: { opportunity: true } },
      contacts: { orderBy: { id: 'asc' }, take: 65 },
      sources: {
        where: { sourceType: { not: SALES_PREPARATION_SOURCE } },
        orderBy: { id: 'asc' },
        take: 201,
      },
      emailThreads: {
        orderBy: { id: 'asc' },
        take: 9,
        include: {
          _count: { select: { messages: true } },
          providerMappings: { orderBy: { id: 'asc' }, include: { providerAccount: true } },
          // Read the newest bounded slice and detect overflow. An earliest-page
          // slice can hide a recent reply while making the writer look current.
          messages: { orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 100 },
        },
      },
    },
  })
  if (!value) throw new ProspectSalesError('NOT_FOUND', 'Prospect venue not found')
  if (value.contacts.length > 64 || value.sources.length > 200 || value.emailThreads.length > 8)
    throw new ProspectSalesError(
      'CONFLICT',
      'Snapshot exceeds bounded slice; select/review its scope rather than silently truncate',
    )
  const { organization, contacts, sources, emailThreads: boundedThreads, ...venue } = value
  const readAt = new Date()
  const threads = boundedThreads.map((thread) => ({
    ...thread,
    messages: [...thread.messages].reverse().map((message) => {
      // Retention cleanup is a separate owner. An expired stored body cannot
      // remain available to a writer merely because its cleanup has not run.
      const expired =
        message.bodyRetentionState === 'TEMPORARY' &&
        (!message.bodyExpiresAt || message.bodyExpiresAt <= readAt)
      return expired ? { ...message, textBody: null, replyProjection: null } : message
    }),
  }))
  const threadCoverage = threads.map((thread) => {
    const issues: string[] = []
    if (thread._count.messages === 0)
      issues.push('No canonical messages are retained for this thread')
    if (thread._count.messages > thread.messages.length)
      issues.push(
        `Only the latest ${thread.messages.length} of ${thread._count.messages} messages are in this bounded thread review`,
      )
    for (const message of thread.messages) {
      if (!message.textBody)
        issues.push(
          `Retained body unavailable for message ${message.id}; source owner must review availability`,
        )
    }
    return { threadId: thread.id, complete: issues.length === 0, issues }
  })
  const importRecords = await client.prospectImportSourceRecord.findMany({
    where: { canonicalVenueId: venue.id },
    orderBy: { id: 'asc' },
    take: 129,
    select: {
      id: true,
      recordKind: true,
      externalRecordId: true,
      sourceWorkbookHash: true,
      recordHash: true,
      rawPayload: true,
      normalizedPayload: true,
      canonicalOrganizationId: true,
      canonicalVenueId: true,
      canonicalContactId: true,
      canonicalEvidenceId: true,
    },
  })
  if (importRecords.length > 128)
    throw new ProspectSalesError('CONFLICT', 'Import lineage exceeds bounded slice')
  const emails = contacts.map((c) => c.normalizedEmail).filter((v): v is string => Boolean(v))
  const addressHolds = emails.length
    ? await client.prospectContact.findMany({
        where: { normalizedEmail: { in: emails }, OR: nativeHoldConditions },
        orderBy: { id: 'asc' },
        take: 65,
        select: {
          id: true,
          normalizedEmail: true,
          doNotContact: true,
          permissionState: true,
          suppressedAt: true,
          unsubscribedAt: true,
          complainedAt: true,
          lastHardBounceAt: true,
          suppressionReason: true,
        },
      })
    : []
  const reasons: string[] = []
  if (venue.archivedAt || organization.archivedAt)
    reasons.push('Native organization or venue is archived')
  if (['PARKED', 'DO_NOT_CONTACT', 'LOST'].includes(organization.opportunity?.stage ?? ''))
    reasons.push(`Native opportunity is ${organization.opportunity!.stage}`)
  for (const contact of contacts.filter(nativeContactHeld))
    reasons.push(
      `Native contact hold: ${contact.id}${contact.suppressionReason ? ` — ${contact.suppressionReason}` : ''}`,
    )
  for (const contact of addressHolds.filter((c) => !contacts.some((own) => own.id === c.id)))
    reasons.push(`Shared-address native hold: ${contact.id}`)
  if (addressHolds.length > 64) reasons.push('Shared-address suppression scope exceeds bound')
  const state = salesJson({
    organization,
    venue,
    contacts,
    sources,
    importRecords,
    threads,
    threadCoverage,
    suppression: {
      blocked: reasons.length > 0,
      reasons,
      addressHolds,
      policy:
        'Native fields/opportunity only; conservatively hold the venue while any candidate or shared address is suppressed',
    },
  })
  return { ...state, snapshotHash: salesHash(state), asOf: new Date().toISOString() }
}

export type NativeSalesSnapshot = Awaited<ReturnType<typeof readNativeSalesSnapshot>>

export const SALES_COMPONENT_STORAGE = 'torchiko.native-component-storage/1'

/** JSONB/Prisma can round nested floating-point WLT ranking scores. Keep exact
 * component JSON bytes authoritative inside the existing evidence JSON owner. */
export function encodeSalesComponent(component: Record<string, unknown>) {
  const componentJson = JSON.stringify(component)
  return {
    schema: SALES_COMPONENT_STORAGE,
    componentJson,
    componentSha256: createHash('sha256').update(componentJson).digest('hex'),
    SEND_AUTHORIZED: false,
  }
}

export function decodeSalesComponent(value: unknown): Record<string, unknown> {
  const stored =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  // Retain failed pre-acceptance evidence; never silently bless its lossy WLT data.
  if (stored.schema !== SALES_COMPONENT_STORAGE)
    return {
      schema: 'unusable-legacy-preparation',
      nativeSnapshotHash: null,
      componentCodeHashes: {},
      preparation: null,
      blocker: 'Legacy component serialization did not round-trip exactly. Prepare again.',
      SEND_AUTHORIZED: false,
    }
  if (
    typeof stored.componentJson !== 'string' ||
    stored.SEND_AUTHORIZED !== false ||
    createHash('sha256').update(stored.componentJson).digest('hex') !== stored.componentSha256
  )
    throw new ProspectSalesError(
      'CONFLICT',
      'Stored component bytes do not match their immutable hash',
    )
  const decoded: unknown = JSON.parse(stored.componentJson)
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new ProspectSalesError('CONFLICT', 'Invalid exact component storage')
  return decoded as Record<string, unknown>
}
