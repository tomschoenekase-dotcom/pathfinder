import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  createProspectInTransaction,
  findProspectDuplicateMatches,
  ProspectActionError,
  ProspectDuplicateReviewError,
  type CreateProspectInput,
  type ProspectActor,
} from './prospect-actions'
import { isAddressBlockedAnywhere, maintenanceReceiptKey } from './prospect-maintenance-actions'
import {
  normalizeProspectDomain,
  normalizeProspectEmail,
  normalizeProspectName,
} from './prospect-normalization'

/**
 * Operator-facing CRM actions that the admin console did not already expose as one reviewed step:
 * typed account field edits, a contact address change that keeps the old address's history and
 * blocks, and prospect creation with a replay receipt. Each is one transaction, compare-and-swaps
 * what it changes, and writes a unique receipt on the activity it records, so a retry or an
 * interrupted apply settles from that receipt without repeating the change.
 */

type Client = typeof db
type Tx = Parameters<Parameters<Client['$transaction']>[0]>[0]

function requireActor(actor: ProspectActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new ProspectActionError('INVALID_INPUT', 'A human platform administrator is required')
  }
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  )
}

const tagSlug = (label: string) => normalizeProspectName(label).replace(/\s+/gu, '-').slice(0, 100)

// ---------------------------------------------------------------------------
// Owner directory
// ---------------------------------------------------------------------------

export type ProspectOwnerRef = { userId: string } | { email: string }

/**
 * Resolves an account owner through the real user directory (the synced identity table). An owner
 * is never guessed from a name or accepted as a free string: an id or an exact address must name
 * one existing user, otherwise this returns null.
 */
export async function resolveProspectOwner(
  client: Pick<Client, 'user'>,
  ref: ProspectOwnerRef,
): Promise<{ id: string; email: string; fullName: string | null } | null> {
  if ('userId' in ref) {
    return client.user.findUnique({
      where: { id: ref.userId },
      select: { id: true, email: true, fullName: true },
    })
  }
  const email = ref.email.trim().toLowerCase()
  if (!email) return null
  return client.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, fullName: true },
  })
}

// ---------------------------------------------------------------------------
// Account field edits
// ---------------------------------------------------------------------------

export type ProspectAccountView = {
  organizationId: string
  name: string
  website: string | null
  domain: string | null
  aliases: string[]
  organizationType: string | null
  city: string | null
  region: string | null
  country: string | null
  tags: string[]
  ownerId: string | null
  archived: boolean
  updatedAt: string
  version: number | null
}

export type ProspectAccountFieldChange = { field: string; from: unknown; to: unknown }

const accountSelect = {
  id: true,
  canonicalName: true,
  website: true,
  normalizedDomain: true,
  aliases: true,
  organizationType: true,
  headquartersCity: true,
  headquartersRegion: true,
  headquartersCountry: true,
  archivedAt: true,
  updatedAt: true,
  opportunity: { select: { id: true, ownerId: true, updatedAt: true } },
  tagAssignments: { select: { tag: { select: { label: true, slug: true, archivedAt: true } } } },
} satisfies Prisma.ProspectOrganizationSelect

type AccountRow = Prisma.ProspectOrganizationGetPayload<{ select: typeof accountSelect }>

function aliasesOf(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (item): item is string => typeof item === 'string',
  )
}

function tagLabelsOf(row: AccountRow): string[] {
  return row.tagAssignments
    .filter((assignment) => assignment.tag.archivedAt === null)
    .map((assignment) => assignment.tag.label)
    .sort((a, b) => a.localeCompare(b))
}

async function accountVersion(tx: Pick<Tx, 'prospectActivity'>, organizationId: string) {
  return 1 + (await tx.prospectActivity.count({ where: { organizationId } }))
}

function accountViewOf(row: AccountRow, version: number | null): ProspectAccountView {
  return {
    organizationId: row.id,
    name: row.canonicalName,
    website: row.website,
    domain: row.normalizedDomain,
    aliases: aliasesOf(row.aliases),
    organizationType: row.organizationType,
    city: row.headquartersCity,
    region: row.headquartersRegion,
    country: row.headquartersCountry,
    tags: tagLabelsOf(row),
    ownerId: row.opportunity?.ownerId ?? null,
    archived: row.archivedAt !== null,
    updatedAt: row.updatedAt.toISOString(),
    version,
  }
}

/** The canonical account fields an operator may edit, as one object. */
export async function readProspectAccountView(
  client: Pick<Client, 'prospectOrganization' | 'prospectActivity'>,
  organizationId: string,
): Promise<ProspectAccountView | null> {
  const row = await client.prospectOrganization.findUnique({
    where: { id: organizationId },
    select: accountSelect,
  })
  if (!row) return null
  return accountViewOf(row, await accountVersion(client, organizationId))
}

export type UpdateProspectAccountInput = {
  organizationId: string
  /** 1 plus the account's activity rows, as `crm.get_account_context` reports. */
  expectedVersion: number
  /** Optional second guard: the organization row's updatedAt as read. */
  expectedUpdatedAt?: Date | undefined
  name?: string | undefined
  website?: string | null | undefined
  aliases?: string[] | undefined
  organizationType?: string | null | undefined
  city?: string | null | undefined
  region?: string | null | undefined
  country?: string | null | undefined
  tags?: string[] | undefined
  /** An id already resolved through the directory (`resolveProspectOwner`). */
  ownerId?: string | null | undefined
  operationKey?: string | undefined
  actor: ProspectActor
}

const trimmedOrNull = (value: string | null) => {
  const text = value?.trim()
  return text ? text : null
}

/**
 * Edits typed account fields. A field left out is unchanged; an explicit null clears it where
 * clearing is allowed (website, type, city, region, country, owner). The name cannot be cleared,
 * and aliases and tags are set as a whole list (an empty list clears them). The change applies
 * only if the account is still at the version the caller read, and it reports exactly which fields
 * changed and the canonical object after. A new name or domain that another live account already
 * has stops for a duplicate review instead of applying.
 */
export async function updateProspectAccountAction(
  input: UpdateProspectAccountInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'account-update')
    : undefined
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await tx.prospectActivity.findUnique({
          where: { externalReceiptKey: receiptKey },
          select: { organizationId: true, evidence: true },
        })
        if (replay) {
          const evidence = replay.evidence as { changes?: ProspectAccountFieldChange[] } | null
          return {
            account: (await readProspectAccountView(tx, replay.organizationId))!,
            changes: evidence?.changes ?? [],
            replayed: true,
          }
        }
      }
      const before = await tx.prospectOrganization.findUnique({
        where: { id: input.organizationId },
        select: accountSelect,
      })
      if (!before || before.archivedAt)
        throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
      if ((await accountVersion(tx, input.organizationId)) !== input.expectedVersion) {
        throw new ProspectActionError('CONFLICT', 'The account changed since it was read')
      }
      if (
        input.expectedUpdatedAt &&
        before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      ) {
        throw new ProspectActionError('CONFLICT', 'The account changed since it was read')
      }

      const changes: ProspectAccountFieldChange[] = []
      const data: Prisma.ProspectOrganizationUncheckedUpdateManyInput = {}
      let nextDomain = before.normalizedDomain
      let nextNormalizedName: string | null = null

      if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name)
          throw new ProspectActionError('INVALID_INPUT', 'The account name cannot be empty')
        if (name !== before.canonicalName) {
          changes.push({ field: 'name', from: before.canonicalName, to: name })
          data.canonicalName = name
          nextNormalizedName = normalizeProspectName(name)
          data.normalizedName = nextNormalizedName
        }
      }
      if (input.website !== undefined) {
        const website = input.website === null ? null : trimmedOrNull(input.website)
        if (website !== before.website) {
          changes.push({ field: 'website', from: before.website, to: website })
          data.website = website
          nextDomain = normalizeProspectDomain(website)
          data.normalizedDomain = nextDomain
        }
      }
      if (input.aliases !== undefined) {
        const aliases = [...new Set(input.aliases.map((alias) => alias.trim()).filter(Boolean))]
        const current = aliasesOf(before.aliases)
        if (JSON.stringify(aliases) !== JSON.stringify(current)) {
          changes.push({ field: 'aliases', from: current, to: aliases })
          data.aliases = aliases
        }
      }
      const scalars = [
        ['organizationType', 'organizationType', before.organizationType],
        ['city', 'headquartersCity', before.headquartersCity],
        ['region', 'headquartersRegion', before.headquartersRegion],
        ['country', 'headquartersCountry', before.headquartersCountry],
      ] as const
      for (const [field, column, current] of scalars) {
        const requested = input[field]
        if (requested === undefined) continue
        const next = requested === null ? null : trimmedOrNull(requested)
        if (next !== current) {
          changes.push({ field, from: current, to: next })
          data[column] = next
        }
      }

      let tagLabels: string[] | null = null
      if (input.tags !== undefined) {
        const seen = new Set<string>()
        const wanted: Array<{ label: string; slug: string }> = []
        for (const raw of input.tags) {
          const label = raw.trim()
          const slug = tagSlug(label)
          if (!label || !slug || seen.has(slug)) continue
          seen.add(slug)
          wanted.push({ label, slug })
        }
        const currentSlugs = before.tagAssignments
          .filter((assignment) => assignment.tag.archivedAt === null)
          .map((assignment) => assignment.tag.slug)
          .sort()
        const wantedSlugs = wanted.map((tag) => tag.slug).sort()
        if (JSON.stringify(currentSlugs) !== JSON.stringify(wantedSlugs)) {
          tagLabels = wanted.map((tag) => tag.label)
          changes.push({ field: 'tags', from: tagLabelsOf(before), to: tagLabels })
          data.tags = tagLabels
        }
      }

      let ownerChange: { from: string | null; to: string | null } | null = null
      if (input.ownerId !== undefined) {
        const next = input.ownerId
        const current = before.opportunity?.ownerId ?? null
        if (next !== current) {
          if (!before.opportunity) {
            throw new ProspectActionError('NOT_FOUND', 'Prospect opportunity not found')
          }
          ownerChange = { from: current, to: next }
          changes.push({ field: 'ownerId', from: current, to: next })
        }
      }

      if (changes.length === 0) {
        // Nothing would change: report that plainly rather than recording an empty edit.
        return {
          account: accountViewOf(before, input.expectedVersion),
          changes,
          replayed: false,
        }
      }

      // A new name or domain that another live account already has is a duplicate decision.
      const rivalClauses = [
        ...(nextNormalizedName !== null ? [{ normalizedName: nextNormalizedName }] : []),
        ...(nextDomain !== before.normalizedDomain && nextDomain
          ? [{ normalizedDomain: nextDomain }]
          : []),
      ]
      if (rivalClauses.length > 0) {
        const rivals = await tx.prospectOrganization.findMany({
          where: { archivedAt: null, id: { not: input.organizationId }, OR: rivalClauses },
          select: { id: true, canonicalName: true, normalizedName: true, normalizedDomain: true },
          orderBy: { id: 'asc' },
          take: 10,
        })
        if (rivals.length) {
          throw new ProspectDuplicateReviewError(
            'Another account already has this name or domain; review the duplicate first.',
            rivals.map((rival) => ({
              organizationId: rival.id,
              canonicalName: rival.canonicalName,
              matchedOn: [
                ...(nextNormalizedName !== null && rival.normalizedName === nextNormalizedName
                  ? (['name'] as const)
                  : []),
                ...(nextDomain && rival.normalizedDomain === nextDomain
                  ? (['domain'] as const)
                  : []),
              ],
            })),
          )
        }
      }

      const now = new Date()
      // Compare-and-swap on the exact organization row that was read.
      const swapped = await tx.prospectOrganization.updateMany({
        where: { id: before.id, updatedAt: before.updatedAt },
        data: { ...data, updatedBy: input.actor.id },
      })
      if (swapped.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'The account changed since it was read')
      }
      if (tagLabels !== null) {
        const wanted: string[] = []
        for (const label of tagLabels) {
          const slug = tagSlug(label)
          const existing = await tx.prospectTag.findUnique({ where: { slug } })
          if (existing?.archivedAt) {
            throw new ProspectActionError(
              'INVALID_INPUT',
              `The tag "${existing.label}" is archived`,
            )
          }
          const tag = existing
            ? existing
            : await tx.prospectTag.create({
                data: { label, slug, createdBy: input.actor.id, updatedBy: input.actor.id },
              })
          wanted.push(tag.id)
          await tx.prospectOrganizationTag.upsert({
            where: { organizationId_tagId: { organizationId: before.id, tagId: tag.id } },
            create: { organizationId: before.id, tagId: tag.id, addedBy: input.actor.id },
            update: {},
          })
        }
        await tx.prospectOrganizationTag.deleteMany({
          where: { organizationId: before.id, tagId: { notIn: wanted } },
        })
      }
      if (ownerChange && before.opportunity) {
        const opportunity = await tx.prospectOpportunity.updateMany({
          where: { id: before.opportunity.id, updatedAt: before.opportunity.updatedAt },
          data: { ownerId: ownerChange.to, updatedBy: input.actor.id },
        })
        if (opportunity.count !== 1) {
          throw new ProspectActionError('CONFLICT', 'The account changed since it was read')
        }
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: before.id,
          // Not a note: its summary differs from a written note, so note lists never include it.
          type: 'NOTE_ADDED',
          summary: 'Account details updated',
          detail: changes.map((change) => change.field).join(', '),
          evidence: { changes } as unknown as Prisma.InputJsonValue,
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await tx.prospectOpportunity.updateMany({
        where: {
          organizationId: before.id,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: now } }],
        },
        data: { lastActivityAt: now, updatedBy: input.actor.id },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.account_updated',
          targetType: 'ProspectOrganization',
          targetId: before.id,
          beforeState: { changed: changes.map((change) => change.field) },
        },
        tx,
      )
      return {
        account: (await readProspectAccountView(tx, before.id))!,
        changes,
        replayed: false,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await client.prospectActivity.findUnique({
      where: { externalReceiptKey: receiptKey },
      select: { organizationId: true, evidence: true },
    })
    if (!replay) throw error
    const evidence = replay.evidence as { changes?: ProspectAccountFieldChange[] } | null
    return {
      account: (await readProspectAccountView(client, replay.organizationId))!,
      changes: evidence?.changes ?? [],
      replayed: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Contact address change
// ---------------------------------------------------------------------------

export type ChangeProspectContactAddressInput = {
  contactId: string
  /** The contact's updatedAt as read; the change applies only if the row is still exactly this. */
  expectedUpdatedAt: Date
  newEmail: string
  /** Archive the old row once the new address exists. Nothing is deleted either way. */
  retireOldAddress: boolean
  reason: string
  operationKey?: string | undefined
  actor: ProspectActor
}

/**
 * True when the contact (not just its address) has declined, complained or been suppressed, so a
 * new address for the same person needs a human decision. A bounce explains a suppression of the
 * address, not of the person, so a bounced address can move on.
 */
export function isProspectContactPersonBlocked(contact: {
  doNotContact: boolean
  unsubscribedAt: Date | null
  complainedAt: Date | null
  permissionState: string
  suppressedAt: Date | null
  lastHardBounceAt: Date | null
}): boolean {
  return (
    contact.doNotContact ||
    contact.unsubscribedAt !== null ||
    contact.complainedAt !== null ||
    contact.permissionState === 'OPTED_OUT' ||
    contact.permissionState === 'PROHIBITED' ||
    (contact.suppressedAt !== null && contact.lastHardBounceAt === null)
  )
}

/**
 * Moves a person to a new address as a new contact row. The old row stays exactly as it was: its
 * address, correspondence history and every suppression remain on it, so the old address stays
 * blocked and its history stays findable. The new row carries the person's name, role, phone and
 * venue but none of the old row's consent or readiness (a new address is verified on its own). A
 * person who declined or complained, an account marked do-not-contact, and any address blocked
 * anywhere in the CRM all stop the change: it never overrides a suppression.
 */
export async function changeProspectContactAddressAction(
  input: ChangeProspectContactAddressInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const reason = input.reason.trim()
  if (!reason) throw new ProspectActionError('INVALID_INPUT', 'A reason is required')
  const newEmail = normalizeProspectEmail(input.newEmail)
  if (!newEmail) throw new ProspectActionError('INVALID_INPUT', 'The email address is not valid')
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'contact-address-change')
    : undefined
  const settle = async (tx: Pick<Tx, 'prospectActivity' | 'prospectContact'>, key: string) => {
    const replay = await tx.prospectActivity.findUnique({
      where: { externalReceiptKey: key },
      select: { contactId: true, evidence: true },
    })
    if (!replay?.contactId) return null
    const evidence = replay.evidence as { replacesContactId?: string } | null
    return {
      newContact: await tx.prospectContact.findUniqueOrThrow({ where: { id: replay.contactId } }),
      oldContact: evidence?.replacesContactId
        ? await tx.prospectContact.findUnique({ where: { id: evidence.replacesContactId } })
        : null,
      replayed: true as const,
    }
  }
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await settle(tx, receiptKey)
        if (replay) return replay
      }
      const old = await tx.prospectContact.findUnique({
        where: { id: input.contactId },
        include: {
          organization: { select: { archivedAt: true, opportunity: { select: { stage: true } } } },
        },
      })
      if (!old || old.organization.archivedAt) {
        throw new ProspectActionError('NOT_FOUND', 'Contact not found')
      }
      if (old.archivedAt) {
        throw new ProspectActionError('INVALID_INPUT', 'An archived contact cannot change address')
      }
      if (old.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new ProspectActionError('CONFLICT', 'The contact changed since it was read')
      }
      if (old.normalizedEmail === newEmail) {
        throw new ProspectActionError('INVALID_INPUT', 'This is already the contact address')
      }
      const personBlocked = isProspectContactPersonBlocked(old)
      if (personBlocked || old.organization.opportunity?.stage === 'DO_NOT_CONTACT') {
        throw new ProspectActionError(
          'SUPPRESSED',
          'This contact or account is suppressed; a person must decide before any new address is added',
        )
      }
      if (await isAddressBlockedAnywhere(tx, newEmail)) {
        throw new ProspectActionError(
          'SUPPRESSED',
          'The new address is blocked on an existing contact record and cannot be added',
        )
      }
      const sameAccount = await tx.prospectContact.findFirst({
        where: { organizationId: old.organizationId, normalizedEmail: newEmail, archivedAt: null },
        select: { id: true },
      })
      if (sameAccount) {
        throw new ProspectActionError('INVALID_INPUT', 'This address is already a contact here')
      }
      const now = new Date()
      const oldProvenance = Array.isArray(old.provenance) ? old.provenance : []
      const created = await tx.prospectContact.create({
        data: {
          organizationId: old.organizationId,
          venueId: old.venueId,
          fullName: old.fullName,
          title: old.title,
          email: newEmail,
          normalizedEmail: newEmail,
          phone: old.phone,
          preferredCommunication: old.preferredCommunication,
          source: 'operator',
          provenance: [
            {
              source: 'operator',
              action: 'address-change',
              replacesContactId: old.id,
              reason,
              recordedAt: now.toISOString(),
              recordedBy: input.actor.id,
            },
          ] as Prisma.InputJsonValue,
          createdBy: input.actor.id,
          updatedBy: input.actor.id,
        },
      })
      // Compare-and-swap the old row. Its address, history and suppression fields are untouched.
      const swapped = await tx.prospectContact.updateMany({
        where: { id: old.id, updatedAt: input.expectedUpdatedAt },
        data: {
          updatedBy: input.actor.id,
          provenance: [
            ...oldProvenance,
            {
              source: 'operator',
              action: 'address-replaced',
              replacedByContactId: created.id,
              reason,
              recordedAt: now.toISOString(),
              recordedBy: input.actor.id,
            },
          ] as Prisma.InputJsonValue,
          ...(input.retireOldAddress ? { archivedAt: now } : {}),
        },
      })
      if (swapped.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'The contact changed since it was read')
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: old.organizationId,
          venueId: created.venueId,
          contactId: created.id,
          type: 'CONTACT_ADDED',
          summary: 'Contact address changed',
          detail: reason,
          evidence: {
            replacesContactId: old.id,
            retiredOldAddress: input.retireOldAddress,
          },
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: old.organizationId,
          venueId: old.venueId,
          contactId: old.id,
          type: 'NOTE_ADDED',
          summary: 'Contact address replaced',
          detail: reason,
          evidence: { replacedByContactId: created.id },
          actorId: input.actor.id,
          occurredAt: now,
        },
      })
      await tx.prospectOpportunity.updateMany({
        where: {
          organizationId: old.organizationId,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: now } }],
        },
        data: { lastActivityAt: now, updatedBy: input.actor.id },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.contact_address_changed',
          targetType: 'ProspectContact',
          targetId: created.id,
          afterState: {
            organizationId: old.organizationId,
            replacesContactId: old.id,
            retiredOldAddress: input.retireOldAddress,
          },
        },
        tx,
      )
      return {
        newContact: created,
        oldContact: await tx.prospectContact.findUniqueOrThrow({ where: { id: old.id } }),
        replayed: false as const,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await settle(client, receiptKey)
    if (!replay) throw error
    return replay
  }
}

// ---------------------------------------------------------------------------
// Prospect creation
// ---------------------------------------------------------------------------

export type CreateProspectForOperatorInput = Omit<CreateProspectInput, 'receiptKey'> & {
  operationKey: string
}

/**
 * Creates a prospect organization (with an optional site and contact) exactly as the admin Add
 * prospect action does, with the same duplicate checks, plus a replay receipt. An exact name,
 * domain or contact-address match on a live account stops with the matches for a person to review;
 * an address blocked anywhere in the CRM stops too. It creates CRM records only: no customer,
 * tenant, venue or outreach.
 */
export async function createProspectForOperatorAction(
  input: CreateProspectForOperatorInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const receiptKey = maintenanceReceiptKey(input.operationKey, 'prospect-create')
  const settle = async (
    tx: Pick<Tx, 'prospectActivity' | 'prospectOrganization' | 'prospectVenue' | 'prospectContact'>,
  ) => {
    const replay = await tx.prospectActivity.findUnique({
      where: { externalReceiptKey: receiptKey },
      select: { organizationId: true, venueId: true, contactId: true },
    })
    if (!replay) return null
    return { ...replay, replayed: true as const }
  }
  const run = () =>
    client.$transaction(async (tx) => {
      const replay = await settle(tx)
      if (replay) return replay
      const canonicalName = input.organization.canonicalName.trim()
      if (!canonicalName) {
        throw new ProspectActionError('INVALID_INPUT', 'Organization name is required')
      }
      const normalizedEmail = normalizeProspectEmail(input.contact?.email)
      if (input.contact?.email && !normalizedEmail) {
        throw new ProspectActionError('INVALID_INPUT', 'The email address is not valid')
      }
      const matches = await findProspectDuplicateMatches(tx, {
        normalizedName: normalizeProspectName(canonicalName),
        normalizedDomain: normalizeProspectDomain(input.organization.website),
        normalizedEmail,
      })
      if (matches.length) {
        throw new ProspectDuplicateReviewError(
          'A matching account already exists; a person must review it before another is created.',
          matches,
        )
      }
      if (normalizedEmail && (await isAddressBlockedAnywhere(tx, normalizedEmail))) {
        throw new ProspectActionError(
          'SUPPRESSED',
          'This address is blocked on an existing contact record and cannot be added again',
        )
      }
      const { operationKey: _operationKey, ...rest } = input
      void _operationKey
      const created = await createProspectInTransaction(
        {
          ...rest,
          organization: { ...rest.organization, source: rest.organization.source ?? 'operator' },
          receiptKey,
        },
        tx,
      )
      return {
        organizationId: created.organization.id,
        venueId: created.venue?.id ?? null,
        contactId: created.contact?.id ?? null,
        replayed: false as const,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const replay = await settle(client)
    if (!replay) throw error
    return replay
  }
}

/** Where a prospect creation recorded its outcome, for settling an interrupted apply. */
export async function findProspectCreateReceipt(
  client: Pick<Client, 'prospectActivity'>,
  operationKey: string,
) {
  return client.prospectActivity.findUnique({
    where: { externalReceiptKey: maintenanceReceiptKey(operationKey, 'prospect-create') },
    select: { organizationId: true, venueId: true, contactId: true },
  })
}
