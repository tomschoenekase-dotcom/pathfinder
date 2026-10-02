import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { ProspectActionError, type ProspectActor } from './prospect-actions'
import {
  evaluateProspectContactEligibility,
  isAddressBlockedOnAnotherRow,
} from './prospect-eligibility'
import { normalizeProspectEmail } from './prospect-normalization'

/**
 * Everyday CRM upkeep: add or correct a contact, set follow-up ownership, append a note. Each
 * action is one transaction, compare-and-swaps the exact row it changes, and carries an optional
 * receipt key written to the activity it records. The receipt column is database-unique, so a
 * retry (or two writers) with one key yields one change and a replay, never a second record.
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

/** The namespaced receipt for one operation of one kind: `operator:<operationId>:<action>`. */
export function maintenanceReceiptKey(operationKey: string, action: string): string {
  return `operator:${operationKey}:${action}`
}

/** A row that refuses this address by itself. Mirrors the sending rules, archived rows included. */
const BLOCKING_CONTACT: Prisma.ProspectContactWhereInput = {
  OR: [
    { doNotContact: true },
    { suppressedAt: { not: null } },
    { unsubscribedAt: { not: null } },
    { complainedAt: { not: null } },
    { lastHardBounceAt: { not: null } },
    { permissionState: { in: ['OPTED_OUT', 'PROHIBITED'] } },
    { emailReadiness: 'INVALID' },
    { organization: { opportunity: { is: { stage: 'DO_NOT_CONTACT' } } } },
  ],
}

/** True when any contact row anywhere, archived or not, blocks this normalized address. */
export async function isAddressBlockedAnywhere(
  tx: Pick<Tx, 'prospectContact'>,
  normalizedEmail: string,
): Promise<boolean> {
  const blocked = await tx.prospectContact.findFirst({
    where: { normalizedEmail, ...BLOCKING_CONTACT },
    select: { id: true },
  })
  return blocked !== null
}

async function monotonicLastActivity(tx: Tx, organizationId: string, at: Date, actorId: string) {
  // Last activity only moves forward.
  await tx.prospectOpportunity.updateMany({
    where: {
      organizationId,
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: at } }],
    },
    data: { lastActivityAt: at, updatedBy: actorId },
  })
}

async function replayByReceipt(client: Client, receiptKey: string | undefined) {
  if (!receiptKey) return null
  return client.prospectActivity.findUnique({
    where: { externalReceiptKey: receiptKey },
    select: { id: true, organizationId: true, contactId: true },
  })
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type CreateProspectContactInput = {
  organizationId: string
  venueId?: string | undefined
  fullName?: string | undefined
  title?: string | undefined
  email?: string | undefined
  phone?: string | undefined
  notes?: string | undefined
  /** Where this contact detail came from; kept on the record. */
  source: string
  operationKey?: string | undefined
  actor: ProspectActor
}

export async function createProspectContactAction(
  input: CreateProspectContactInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'contact-create')
    : undefined
  const fullName = input.fullName?.trim() || undefined
  const email = input.email === undefined ? null : normalizeProspectEmail(input.email)
  if (input.email !== undefined && !email) {
    throw new ProspectActionError('INVALID_INPUT', 'The email address is not valid')
  }
  if (!fullName && !email) {
    throw new ProspectActionError('INVALID_INPUT', 'A contact needs a name or an email address')
  }
  const run = () =>
    client.$transaction(async (tx) => {
      const replay = receiptKey
        ? await tx.prospectActivity.findUnique({
            where: { externalReceiptKey: receiptKey },
            select: { contactId: true },
          })
        : null
      if (replay?.contactId) {
        const contact = await tx.prospectContact.findUniqueOrThrow({
          where: { id: replay.contactId },
        })
        return { contact, replayed: true }
      }
      const organization = await tx.prospectOrganization.findUnique({
        where: { id: input.organizationId },
        select: { id: true, archivedAt: true },
      })
      if (!organization || organization.archivedAt) {
        throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
      }
      if (input.venueId) {
        const venue = await tx.prospectVenue.findFirst({
          where: { id: input.venueId, organizationId: input.organizationId, archivedAt: null },
          select: { id: true },
        })
        if (!venue) throw new ProspectActionError('NOT_FOUND', 'Venue not found for this prospect')
      }
      if (email) {
        // A suppressed address stays suppressed: a new, clean-looking row must never reopen it.
        if (await isAddressBlockedAnywhere(tx, email)) {
          throw new ProspectActionError(
            'SUPPRESSED',
            'This address is blocked on an existing contact record and cannot be added again',
          )
        }
        const existing = await tx.prospectContact.findFirst({
          where: { organizationId: input.organizationId, normalizedEmail: email, archivedAt: null },
          select: { id: true },
        })
        if (existing) {
          throw new ProspectActionError('CONFLICT', 'This address is already a contact here')
        }
      }
      const now = new Date()
      const contact = await tx.prospectContact.create({
        data: {
          organizationId: input.organizationId,
          venueId: input.venueId ?? null,
          fullName: fullName ?? null,
          title: input.title?.trim() || null,
          email: email,
          normalizedEmail: email,
          phone: input.phone?.trim() || null,
          notes: input.notes?.trim() || null,
          source: 'operator',
          provenance: [
            { source: input.source, recordedAt: now.toISOString(), recordedBy: input.actor.id },
          ],
          createdBy: input.actor.id,
          updatedBy: input.actor.id,
        },
      })
      await tx.prospectActivity.create({
        data: {
          organizationId: input.organizationId,
          venueId: contact.venueId,
          contactId: contact.id,
          type: 'CONTACT_ADDED',
          summary: 'Contact added',
          detail: input.source,
          evidence: { source: input.source },
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await monotonicLastActivity(tx, input.organizationId, now, input.actor.id)
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.contact_created',
          targetType: 'ProspectContact',
          targetId: contact.id,
          afterState: { organizationId: input.organizationId, hasEmail: email !== null },
        },
        tx,
      )
      return { contact, replayed: false }
    })
  try {
    return await run()
  } catch (error) {
    // Two writers with one key: the loser's unique receipt collision is the replay.
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await replayByReceipt(client, receiptKey)
    if (!replay?.contactId) throw error
    const contact = await client.prospectContact.findUniqueOrThrow({
      where: { id: replay.contactId },
    })
    return { contact, replayed: true }
  }
}

export type UpdateProspectContactInput = {
  contactId: string
  /** The contact's updatedAt as read; the change applies only if the row is still exactly this. */
  expectedUpdatedAt: Date
  fullName?: string | undefined
  title?: string | null | undefined
  phone?: string | null | undefined
  notes?: string | null | undefined
  venueId?: string | null | undefined
  operationKey?: string | undefined
  actor: ProspectActor
}

/**
 * Corrects details of one contact. The address and every suppression field are not editable here:
 * a changed address is a new contact (so the old one keeps its history and its blocks), and lifting
 * a suppression is its own audited action.
 */
export async function updateProspectContactAction(
  input: UpdateProspectContactInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'contact-update')
    : undefined
  const changes = ['fullName', 'title', 'phone', 'notes', 'venueId'].filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  )
  if (changes.length === 0) {
    throw new ProspectActionError('INVALID_INPUT', 'Provide at least one field to change')
  }
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await tx.prospectActivity.findUnique({
          where: { externalReceiptKey: receiptKey },
          select: { contactId: true },
        })
        if (replay?.contactId) {
          return {
            contact: await tx.prospectContact.findUniqueOrThrow({
              where: { id: replay.contactId },
            }),
            replayed: true,
          }
        }
      }
      const before = await tx.prospectContact.findUnique({ where: { id: input.contactId } })
      if (!before) throw new ProspectActionError('NOT_FOUND', 'Contact not found')
      if (input.venueId) {
        const venue = await tx.prospectVenue.findFirst({
          where: { id: input.venueId, organizationId: before.organizationId, archivedAt: null },
          select: { id: true },
        })
        if (!venue) throw new ProspectActionError('NOT_FOUND', 'Venue not found for this prospect')
      }
      const now = new Date()
      const data: Prisma.ProspectContactUncheckedUpdateManyInput = {
        updatedBy: input.actor.id,
        ...(input.fullName !== undefined ? { fullName: input.fullName.trim() || null } : {}),
        ...(input.title !== undefined ? { title: input.title?.trim() || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
        provenance: [
          ...(Array.isArray(before.provenance) ? before.provenance : []),
          {
            source: 'operator',
            recordedAt: now.toISOString(),
            recordedBy: input.actor.id,
            changed: changes,
          },
        ] as Prisma.InputJsonValue,
      }
      // Compare-and-swap on the exact row that was read: a concurrent edit makes this a conflict.
      const swapped = await tx.prospectContact.updateMany({
        where: { id: before.id, updatedAt: input.expectedUpdatedAt },
        data,
      })
      if (swapped.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'The contact changed since it was read')
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: before.organizationId,
          venueId: before.venueId,
          contactId: before.id,
          type: 'NOTE_ADDED',
          // Not a note: its summary differs from a written note, so note lists never include it.
          summary: 'Contact details updated',
          detail: changes.join(', '),
          evidence: { changed: changes },
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.contact_updated',
          targetType: 'ProspectContact',
          targetId: before.id,
          beforeState: { changed: changes },
        },
        tx,
      )
      return {
        contact: await tx.prospectContact.findUniqueOrThrow({ where: { id: before.id } }),
        replayed: false,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await replayByReceipt(client, receiptKey)
    if (!replay?.contactId) throw error
    return {
      contact: await client.prospectContact.findUniqueOrThrow({ where: { id: replay.contactId } }),
      replayed: true,
    }
  }
}

export async function setProspectContactArchivedAction(
  input: {
    contactId: string
    expectedUpdatedAt: Date
    archived: boolean
    reason: string
    operationKey?: string | undefined
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  if (!input.reason.trim()) throw new ProspectActionError('INVALID_INPUT', 'Reason is required')
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(
        input.operationKey,
        input.archived ? 'contact-archive' : 'contact-restore',
      )
    : undefined
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await tx.prospectActivity.findUnique({
          where: { externalReceiptKey: receiptKey },
          select: { contactId: true },
        })
        if (replay?.contactId) {
          return {
            contact: await tx.prospectContact.findUniqueOrThrow({
              where: { id: replay.contactId },
            }),
            replayed: true,
          }
        }
      }
      const before = await tx.prospectContact.findUnique({ where: { id: input.contactId } })
      if (!before) throw new ProspectActionError('NOT_FOUND', 'Contact not found')
      const now = new Date()
      const swapped = await tx.prospectContact.updateMany({
        where: { id: before.id, updatedAt: input.expectedUpdatedAt },
        data: { archivedAt: input.archived ? now : null, updatedBy: input.actor.id },
      })
      if (swapped.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'The contact changed since it was read')
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: before.organizationId,
          venueId: before.venueId,
          contactId: before.id,
          type: input.archived ? 'ARCHIVED' : 'RESTORED',
          summary: input.archived ? 'Contact archived' : 'Contact restored',
          detail: input.reason.trim(),
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: input.archived
            ? 'admin.prospect.contact_archived'
            : 'admin.prospect.contact_restored',
          targetType: 'ProspectContact',
          targetId: before.id,
        },
        tx,
      )
      return {
        contact: await tx.prospectContact.findUniqueOrThrow({ where: { id: before.id } }),
        replayed: false,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await replayByReceipt(client, receiptKey)
    if (!replay?.contactId) throw error
    return {
      contact: await client.prospectContact.findUniqueOrThrow({ where: { id: replay.contactId } }),
      replayed: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Follow-up ownership and notes
// ---------------------------------------------------------------------------

export type UpdateProspectFollowupInput = {
  organizationId: string
  /** 1 plus the organization's activity rows, as reported by the reads. */
  expectedVersion: number
  ownerId?: string | null | undefined
  nextAction?: string | null | undefined
  nextActionAt?: Date | null | undefined
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined
  operationKey?: string | undefined
  actor: ProspectActor
}

/** Sets who owns the account, what happens next and by when, without touching its stage. */
export async function updateProspectFollowupAction(
  input: UpdateProspectFollowupInput,
  client: Client = db,
) {
  requireActor(input.actor)
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'followup')
    : undefined
  const changes = ['ownerId', 'nextAction', 'nextActionAt', 'priority'].filter(
    (key) => (input as Record<string, unknown>)[key] !== undefined,
  )
  if (changes.length === 0) {
    throw new ProspectActionError('INVALID_INPUT', 'Provide at least one field to change')
  }
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await tx.prospectActivity.findUnique({
          where: { externalReceiptKey: receiptKey },
          select: { organizationId: true },
        })
        if (replay) {
          return {
            opportunity: await tx.prospectOpportunity.findUniqueOrThrow({
              where: { organizationId: replay.organizationId },
            }),
            replayed: true,
          }
        }
      }
      const before = await tx.prospectOpportunity.findUnique({
        where: { organizationId: input.organizationId },
        include: { organization: { select: { archivedAt: true } } },
      })
      if (!before || before.organization.archivedAt) {
        throw new ProspectActionError('NOT_FOUND', 'Prospect opportunity not found')
      }
      const activities = await tx.prospectActivity.count({
        where: { organizationId: input.organizationId },
      })
      if (1 + activities !== input.expectedVersion) {
        throw new ProspectActionError('CONFLICT', 'The prospect changed since it was read')
      }
      const now = new Date()
      const swapped = await tx.prospectOpportunity.updateMany({
        where: { id: before.id, updatedAt: before.updatedAt },
        data: {
          updatedBy: input.actor.id,
          lastActivityAt: now,
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
          ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
          ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        },
      })
      if (swapped.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'The prospect changed since it was read')
      }
      await tx.prospectActivity.create({
        data: {
          organizationId: input.organizationId,
          type: 'NOTE_ADDED',
          summary: 'Follow-up details updated',
          detail: changes.join(', '),
          evidence: {
            changed: changes,
            before: {
              ownerId: before.ownerId,
              nextAction: before.nextAction,
              nextActionAt: before.nextActionAt?.toISOString() ?? null,
              priority: before.priority,
            },
          },
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.followup_updated',
          targetType: 'ProspectOpportunity',
          targetId: before.id,
          beforeState: { changed: changes },
        },
        tx,
      )
      return {
        opportunity: await tx.prospectOpportunity.findUniqueOrThrow({ where: { id: before.id } }),
        replayed: false,
      }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const replay = await replayByReceipt(client, receiptKey)
    if (!replay) throw error
    return {
      opportunity: await client.prospectOpportunity.findUniqueOrThrow({
        where: { organizationId: replay.organizationId },
      }),
      replayed: true,
    }
  }
}

/** Appends a note. Notes only add, so there is nothing to compare-and-swap; the receipt dedupes. */
export async function appendProspectNoteAction(
  input: {
    organizationId: string
    note: string
    source?: string | undefined
    operationKey?: string | undefined
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  const text = input.note.trim()
  if (!text) throw new ProspectActionError('INVALID_INPUT', 'Note is required')
  const receiptKey = input.operationKey
    ? maintenanceReceiptKey(input.operationKey, 'note')
    : undefined
  const run = () =>
    client.$transaction(async (tx) => {
      if (receiptKey) {
        const replay = await tx.prospectActivity.findUnique({
          where: { externalReceiptKey: receiptKey },
        })
        if (replay) return { activity: replay, replayed: true }
      }
      const organization = await tx.prospectOrganization.findUnique({
        where: { id: input.organizationId },
        select: { id: true, archivedAt: true },
      })
      if (!organization || organization.archivedAt) {
        throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
      }
      const now = new Date()
      const activity = await tx.prospectActivity.create({
        data: {
          organizationId: organization.id,
          type: 'NOTE_ADDED',
          // The same summary the dashboard's own note action writes, so notes read as one list.
          summary: 'Operator note added',
          detail: text,
          evidence: input.source ? { source: input.source } : {},
          actorId: input.actor.id,
          occurredAt: now,
          ...(receiptKey ? { externalReceiptKey: receiptKey } : {}),
        },
      })
      await monotonicLastActivity(tx, organization.id, now, input.actor.id)
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect.note_added',
          targetType: 'ProspectOrganization',
          targetId: organization.id,
        },
        tx,
      )
      return { activity, replayed: false }
    })
  try {
    return await run()
  } catch (error) {
    if (!isUniqueViolation(error) || !receiptKey) throw error
    const winner = await client.prospectActivity.findUnique({
      where: { externalReceiptKey: receiptKey },
    })
    if (!winner) throw error
    return { activity: winner, replayed: true }
  }
}

// ---------------------------------------------------------------------------
// Duplicate review
// ---------------------------------------------------------------------------

/**
 * Records a reviewed decision about a pair of accounts. The pair is stored once in canonical order,
 * so declaring (A, B) and (B, A) is the same record. A pair the duplicate scan never flagged is
 * created already resolved, marked as declared by a person. Nothing is merged, moved or deleted:
 * both accounts keep every contact, activity, message and receipt they had.
 */
export async function resolveProspectDuplicatePairAction(
  input: {
    organizationId: string
    otherOrganizationId: string
    resolution: 'CONFIRMED_DUPLICATE' | 'CONFIRMED_DISTINCT' | 'DISMISSED'
    note: string
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  if (!input.note.trim()) throw new ProspectActionError('INVALID_INPUT', 'Review note is required')
  if (input.organizationId === input.otherOrganizationId) {
    throw new ProspectActionError('INVALID_INPUT', 'A duplicate pair needs two different accounts')
  }
  const [organizationAId, organizationBId] =
    input.organizationId < input.otherOrganizationId
      ? [input.organizationId, input.otherOrganizationId]
      : [input.otherOrganizationId, input.organizationId]
  const run = () =>
    client.$transaction(async (tx) => {
      const found = await tx.prospectOrganization.findMany({
        where: { id: { in: [organizationAId, organizationBId] } },
        select: { id: true },
      })
      if (found.length !== 2) throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
      const note = input.note.trim()
      const existing = await tx.prospectDuplicateCandidate.findUnique({
        where: { organizationAId_organizationBId: { organizationAId, organizationBId } },
      })
      let saved
      if (!existing) {
        saved = await tx.prospectDuplicateCandidate.create({
          data: {
            organizationAId,
            organizationBId,
            status: input.resolution,
            confidence: 1,
            reasons: [{ type: 'declared_by_reviewer' }],
            resolutionNote: note,
            reviewedBy: input.actor.id,
            reviewedAt: new Date(),
          },
        })
      } else if (existing.status === input.resolution) {
        // The same decision again: nothing changes, and the caller is told it was a replay.
        return { candidate: existing, replayed: true }
      } else if (existing.status !== 'OPEN') {
        throw new ProspectActionError('CONFLICT', 'This pair was already resolved differently')
      } else {
        const swapped = await tx.prospectDuplicateCandidate.updateMany({
          where: { id: existing.id, status: 'OPEN' },
          data: {
            status: input.resolution,
            resolutionNote: note,
            reviewedBy: input.actor.id,
            reviewedAt: new Date(),
          },
        })
        if (swapped.count !== 1) {
          throw new ProspectActionError('CONFLICT', 'Duplicate candidate is already resolved')
        }
        saved = await tx.prospectDuplicateCandidate.findUniqueOrThrow({
          where: { id: existing.id },
        })
      }
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'admin.prospect_duplicate.reviewed',
          targetType: 'ProspectDuplicateCandidate',
          targetId: saved.id,
          beforeState: { status: existing?.status ?? 'NONE' },
          afterState: { status: saved.status, note },
        },
        tx,
      )
      return { candidate: saved, replayed: false }
    })
  try {
    return await run()
  } catch (error) {
    // Two writers creating the same new pair: the loser re-reads and applies the same rules.
    if (!isUniqueViolation(error)) throw error
    return run()
  }
}

// ---------------------------------------------------------------------------
// Campaign membership
// ---------------------------------------------------------------------------

/**
 * Adds one account to an existing campaign. The campaign creator could only select members when it
 * created the campaign, so a prepared campaign had no way to grow. A named contact stays selected;
 * with none named, the first contact that may be drafted to is chosen. An account with nobody to
 * write to is added as SUPPRESSED so the gap is visible instead of silently dropped. Adding the same
 * account and contact again returns the existing member.
 */
export async function addProspectCampaignMemberAction(
  input: {
    campaignId: string
    organizationId: string
    contactId?: string | undefined
    venueId?: string | undefined
    /** Stored on the member so an interrupted add can be found again by this exact key. */
    receipt?: string | undefined
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  return client.$transaction(async (tx) => {
    const campaign = await tx.prospectOutreachCampaign.findUnique({
      where: { id: input.campaignId },
      select: { id: true, status: true },
    })
    if (!campaign) throw new ProspectActionError('NOT_FOUND', 'Campaign not found')
    if (campaign.status === 'COMPLETE' || campaign.status === 'CANCELLED') {
      throw new ProspectActionError('CONFLICT', 'This campaign is closed to new members')
    }
    const organization = await tx.prospectOrganization.findFirst({
      where: { id: input.organizationId, archivedAt: null },
      select: {
        id: true,
        opportunity: { select: { stage: true } },
        venues: {
          where: { archivedAt: null },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { id: true },
        },
      },
    })
    if (!organization) throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
    if (input.venueId) {
      const venue = await tx.prospectVenue.findFirst({
        where: { id: input.venueId, organizationId: input.organizationId, archivedAt: null },
        select: { id: true },
      })
      if (!venue) throw new ProspectActionError('NOT_FOUND', 'Venue not found for this prospect')
    }
    const contactSelect = {
      id: true,
      venueId: true,
      normalizedEmail: true,
      doNotContact: true,
      emailReadiness: true,
      permissionState: true,
      suppressedAt: true,
      unsubscribedAt: true,
      complainedAt: true,
      lastHardBounceAt: true,
      archivedAt: true,
    } as const
    const draftable = async (
      contact: {
        id: string
        normalizedEmail: string | null
      } & Parameters<typeof evaluateProspectContactEligibility>[0],
    ) =>
      contact.normalizedEmail !== null &&
      evaluateProspectContactEligibility(contact, 'draft', {
        organizationStage: organization.opportunity?.stage ?? null,
        blockedElsewhere: await isAddressBlockedOnAnotherRow(
          tx,
          contact.normalizedEmail,
          contact.id,
        ),
      }).eligible
    let chosen: { id: string; venueId: string | null } | null = null
    let eligible = false
    if (input.contactId) {
      const named = await tx.prospectContact.findFirst({
        where: { id: input.contactId, organizationId: input.organizationId },
        select: contactSelect,
      })
      if (!named) throw new ProspectActionError('NOT_FOUND', 'Contact not found for this prospect')
      chosen = named
      eligible = await draftable(named)
    } else {
      const candidates = await tx.prospectContact.findMany({
        where: { organizationId: input.organizationId, archivedAt: null },
        orderBy: [{ venueId: 'asc' }, { createdAt: 'asc' }],
        select: contactSelect,
      })
      for (const candidate of candidates) {
        if (await draftable(candidate)) {
          chosen = candidate
          eligible = true
          break
        }
      }
    }
    const existing = await tx.prospectCampaignMember.findFirst({
      where: {
        campaignId: input.campaignId,
        organizationId: input.organizationId,
        contactId: chosen?.id ?? null,
      },
    })
    if (existing) return { member: existing, replayed: true }
    const member = await tx.prospectCampaignMember.create({
      data: {
        campaignId: input.campaignId,
        organizationId: input.organizationId,
        venueId: input.venueId ?? chosen?.venueId ?? organization.venues[0]?.id ?? null,
        contactId: chosen?.id ?? null,
        status: eligible ? 'SELECTED' : 'SUPPRESSED',
        selection: {
          selectedBy: input.actor.id,
          selectedAt: new Date().toISOString(),
          basis: input.contactId ? 'named_contact' : 'first_eligible_contact',
          ...(input.receipt ? { receipt: input.receipt } : {}),
        },
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_campaign.member_added',
        targetType: 'ProspectCampaignMember',
        targetId: member.id,
        afterState: { campaignId: input.campaignId, status: member.status },
      },
      tx,
    )
    return { member, replayed: false }
  })
}
