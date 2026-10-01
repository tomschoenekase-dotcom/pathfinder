import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  appendProspectNoteAction,
  archiveProspectAction,
  createProspectContactAction,
  isAddressBlockedAnywhere,
  maintenanceReceiptKey,
  setProspectContactArchivedAction,
  updateProspectContactAction,
  updateProspectFollowupAction,
} from '@pathfinder/db'

import type { OperatorDatabase } from '../audit'
import { OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
  type StoredOperatorProposal,
} from '../proposals'
import { prospectOrganizationVersion } from './crm-stage-change'
import { operatorReason } from './shared'

/**
 * Everyday CRM upkeep as reviewable proposals. Each one goes through a canonical db action that
 * compare-and-swaps the row it changes and writes a unique receipt on the activity it records,
 * so a retry or an interrupted apply can be settled from that receipt without repeating the change.
 */

const normalizeEmail = (value: string) => value.trim().toLowerCase()

async function receiptActivity(database: OperatorDatabase, receiptKey: string) {
  return database.prospectActivity.findUnique({
    where: { externalReceiptKey: receiptKey },
    select: { id: true, organizationId: true, contactId: true },
  })
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const contactCreateInput = OPERATOR_MCP_INPUTS['crm.propose_contact_create']
type ContactCreateArgs = ReturnType<typeof contactCreateInput.parse>

async function sameAddressRows(database: OperatorDatabase, args: ContactCreateArgs) {
  if (args.email === undefined) return null
  return database.prospectContact.count({
    where: {
      organizationId: args.organizationId,
      normalizedEmail: normalizeEmail(args.email),
      archivedAt: null,
    },
  })
}

export const crmContactCreateKind: OperatorProposalKind<ContactCreateArgs> = {
  kind: 'crm.contact-create',
  tool: 'crm.propose_contact_create',
  capability: 'crm:propose',
  parse: (raw) => contactCreateInput.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const organization = await context.database.prospectOrganization.findFirst({
      where: { id: args.organizationId, archivedAt: null },
      select: { id: true },
    })
    if (!organization) throw new OperatorNotFoundError()
    if (
      args.email !== undefined &&
      (await isAddressBlockedAnywhere(context.database, normalizeEmail(args.email)))
    ) {
      throw Object.assign(new Error('This address is blocked on an existing contact record.'), {
        code: 'ADDRESS_SUPPRESSED',
      })
    }
  },
  targetVersion: async (args, context) => {
    const rows = await sameAddressRows(context.database, args)
    return rows === null ? null : String(rows)
  },
  currentVersion: async (args, context) => {
    const rows = await sameAddressRows(context.database, args)
    return rows === null ? null : String(rows)
  },
  describe: (args) => ({
    title: 'Add a contact',
    lines: [
      ...(args.fullName ? [`name: ${args.fullName}`] : []),
      ...(args.title ? [`role: ${args.title}`] : []),
      ...(args.email ? [`email: ${args.email}`] : []),
      ...(args.phone ? [`phone: ${args.phone}`] : []),
      ...(args.notes ? [`notes: ${args.notes}`] : []),
      `source: ${args.source}`,
    ],
  }),
  snapshot: async (args, context) =>
    ({
      organizationId: args.organizationId,
      matchingAddressRows: await sameAddressRows(context.database, args),
    }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const created = await createProspectContactAction(
      {
        organizationId: args.organizationId,
        ...(args.venueId !== undefined ? { venueId: args.venueId } : {}),
        ...(args.fullName !== undefined ? { fullName: args.fullName } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.email !== undefined ? { email: args.email } : {}),
        ...(args.phone !== undefined ? { phone: args.phone } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        source: args.source,
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        contactId: created.contact.id,
        organizationId: args.organizationId,
        replayed: created.replayed,
      },
      after: {
        contactId: created.contact.id,
        updatedAt: created.contact.updatedAt.toISOString(),
      },
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(context.operationId, 'contact-create'),
    )
    if (!receipt) return { state: 'not_applied' }
    if (!receipt.contactId) return { state: 'unknown' }
    const contact = await context.database.prospectContact.findUniqueOrThrow({
      where: { id: receipt.contactId },
      select: { id: true, updatedAt: true },
    })
    return {
      state: 'applied',
      outcome: {
        result: { contactId: contact.id, organizationId: args.organizationId, replayed: false },
        after: { contactId: contact.id, updatedAt: contact.updatedAt.toISOString() },
      },
    }
  },
  /** Archives the contact it created. Nothing is deleted, and any block on the address stays. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as { contactId?: string; updatedAt?: string } | null
    if (!after?.contactId || !after.updatedAt) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    const archived = await setProspectContactArchivedAction(
      {
        contactId: after.contactId,
        expectedUpdatedAt: new Date(after.updatedAt),
        archived: true,
        reason: `Reverted. ${operatorReason(original.id)}`,
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: { contactId: archived.contact.id, archived: true },
      after: {
        contactId: archived.contact.id,
        updatedAt: archived.contact.updatedAt.toISOString(),
      },
    }
  },
}

const contactUpdateInput = OPERATOR_MCP_INPUTS['crm.propose_contact_update']
type ContactUpdateArgs = ReturnType<typeof contactUpdateInput.parse>

type ContactFields = {
  contactId: string
  fullName: string | null
  title: string | null
  phone: string | null
  notes: string | null
  venueId: string | null
  updatedAt: string
}

async function readContactFields(
  database: OperatorDatabase,
  contactId: string,
): Promise<ContactFields | null> {
  const contact = await database.prospectContact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      fullName: true,
      title: true,
      phone: true,
      notes: true,
      venueId: true,
      updatedAt: true,
      organization: { select: { archivedAt: true } },
    },
  })
  if (!contact || contact.organization.archivedAt) return null
  return {
    contactId: contact.id,
    fullName: contact.fullName,
    title: contact.title,
    phone: contact.phone,
    notes: contact.notes,
    venueId: contact.venueId,
    updatedAt: contact.updatedAt.toISOString(),
  }
}

export const crmContactUpdateKind: OperatorProposalKind<ContactUpdateArgs> = {
  kind: 'crm.contact-update',
  tool: 'crm.propose_contact_update',
  capability: 'crm:propose',
  parse: (raw) => contactUpdateInput.parse(raw),
  target: (args) => ({ ref: args.contactId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!(await readContactFields(context.database, args.contactId))) {
      throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await readContactFields(context.database, args.contactId))?.updatedAt ?? null,
  describe: (args) => ({
    title: 'Correct a contact',
    lines: [
      ...(args.fullName !== undefined ? [`name → ${args.fullName}`] : []),
      ...(args.title !== undefined ? [`role → ${args.title ?? 'cleared'}`] : []),
      ...(args.phone !== undefined ? [`phone → ${args.phone ?? 'cleared'}`] : []),
      ...(args.notes !== undefined ? [`notes → ${args.notes ?? 'cleared'}`] : []),
      ...(args.venueId !== undefined ? [`venue → ${args.venueId ?? 'none'}`] : []),
    ],
  }),
  snapshot: async (args, context) =>
    (await readContactFields(context.database, args.contactId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const saved = await updateProspectContactAction(
      {
        contactId: args.contactId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        ...(args.fullName !== undefined ? { fullName: args.fullName } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.phone !== undefined ? { phone: args.phone } : {}),
        ...(args.notes !== undefined ? { notes: args.notes } : {}),
        ...(args.venueId !== undefined ? { venueId: args.venueId } : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    const after = await readContactFields(context.database, args.contactId)
    return {
      result: {
        contactId: args.contactId,
        updatedAt: saved.contact.updatedAt.toISOString(),
        replayed: saved.replayed,
      },
      after: after as unknown as JsonValue,
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(context.operationId, 'contact-update'),
    )
    if (!receipt) return { state: 'not_applied' }
    const after = await readContactFields(context.database, args.contactId)
    if (!after) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: { contactId: args.contactId, updatedAt: after.updatedAt, replayed: false },
        after: after as unknown as JsonValue,
      },
    }
  },
  /** Restores the fields this proposal changed, only if the contact has not moved since. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const before = original.beforeSnapshot as ContactFields | null
    const after = original.afterSnapshot as ContactFields | null
    const args = original.args as ContactUpdateArgs
    if (!before || !after) throw new OperatorStaleError('The original snapshot is incomplete.')
    const restored = await updateProspectContactAction(
      {
        contactId: before.contactId,
        expectedUpdatedAt: new Date(after.updatedAt),
        ...(args.fullName !== undefined && before.fullName !== null
          ? { fullName: before.fullName }
          : {}),
        ...(args.title !== undefined ? { title: before.title } : {}),
        ...(args.phone !== undefined ? { phone: before.phone } : {}),
        ...(args.notes !== undefined ? { notes: before.notes } : {}),
        ...(args.venueId !== undefined ? { venueId: before.venueId } : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    const now = await readContactFields(context.database, before.contactId)
    return {
      result: { contactId: before.contactId, updatedAt: restored.contact.updatedAt.toISOString() },
      after: now as unknown as JsonValue,
    }
  },
}

const contactArchiveInput = OPERATOR_MCP_INPUTS['crm.propose_contact_archive']
type ContactArchiveArgs = ReturnType<typeof contactArchiveInput.parse>

export const crmContactArchiveKind: OperatorProposalKind<ContactArchiveArgs> = {
  kind: 'crm.contact-archive',
  tool: 'crm.propose_contact_archive',
  capability: 'crm:propose',
  parse: (raw) => contactArchiveInput.parse(raw),
  target: (args) => ({ ref: args.contactId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!(await readContactFields(context.database, args.contactId))) {
      throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await readContactFields(context.database, args.contactId))?.updatedAt ?? null,
  describe: (args) => ({
    title: args.archived ? 'Archive a contact' : 'Restore a contact',
    lines: [`contact ${args.contactId}`, `reason: ${args.reason}`],
  }),
  snapshot: async (args, context) =>
    (await readContactFields(context.database, args.contactId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const saved = await setProspectContactArchivedAction(
      {
        contactId: args.contactId,
        expectedUpdatedAt: new Date(args.expectedUpdatedAt),
        archived: args.archived,
        reason: args.reason,
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        contactId: args.contactId,
        archived: saved.contact.archivedAt !== null,
        updatedAt: saved.contact.updatedAt.toISOString(),
        replayed: saved.replayed,
      },
      after: { contactId: args.contactId, updatedAt: saved.contact.updatedAt.toISOString() },
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(
        context.operationId,
        args.archived ? 'contact-archive' : 'contact-restore',
      ),
    )
    if (!receipt) return { state: 'not_applied' }
    const contact = await context.database.prospectContact.findUnique({
      where: { id: args.contactId },
      select: { archivedAt: true, updatedAt: true },
    })
    if (!contact) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: {
          contactId: args.contactId,
          archived: contact.archivedAt !== null,
          updatedAt: contact.updatedAt.toISOString(),
          replayed: false,
        },
        after: { contactId: args.contactId, updatedAt: contact.updatedAt.toISOString() },
      },
    }
  },
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as { contactId?: string; updatedAt?: string } | null
    const args = original.args as ContactArchiveArgs
    if (!after?.contactId || !after.updatedAt) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    const saved = await setProspectContactArchivedAction(
      {
        contactId: after.contactId,
        expectedUpdatedAt: new Date(after.updatedAt),
        archived: !args.archived,
        reason: `Reverted. ${operatorReason(original.id)}`,
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: { contactId: after.contactId, archived: saved.contact.archivedAt !== null },
      after: { contactId: after.contactId, updatedAt: saved.contact.updatedAt.toISOString() },
    }
  },
}

// ---------------------------------------------------------------------------
// Follow-up ownership, notes, account archive
// ---------------------------------------------------------------------------

const followupInput = OPERATOR_MCP_INPUTS['crm.propose_followup_update']
type FollowupArgs = ReturnType<typeof followupInput.parse>

type FollowupFields = {
  organizationId: string
  ownerId: string | null
  nextAction: string | null
  nextActionAt: string | null
  priority: string
  version: number | null
}

async function readFollowup(
  database: OperatorDatabase,
  organizationId: string,
): Promise<FollowupFields | null> {
  const opportunity = await database.prospectOpportunity.findUnique({
    where: { organizationId },
    select: {
      ownerId: true,
      nextAction: true,
      nextActionAt: true,
      priority: true,
      organization: { select: { archivedAt: true } },
    },
  })
  if (!opportunity || opportunity.organization.archivedAt) return null
  return {
    organizationId,
    ownerId: opportunity.ownerId,
    nextAction: opportunity.nextAction,
    nextActionAt: opportunity.nextActionAt?.toISOString() ?? null,
    priority: opportunity.priority,
    version: await prospectOrganizationVersion(database, organizationId),
  }
}

export const crmFollowupUpdateKind: OperatorProposalKind<FollowupArgs> = {
  kind: 'crm.followup-update',
  tool: 'crm.propose_followup_update',
  capability: 'crm:propose',
  parse: (raw) => followupInput.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    if (!(await readFollowup(context.database, args.organizationId))) {
      throw new OperatorNotFoundError()
    }
  },
  targetVersion: async (args) => String(args.expectedVersion),
  currentVersion: async (args, context) => {
    const version = await prospectOrganizationVersion(context.database, args.organizationId)
    return version === null ? null : String(version)
  },
  describe: (args) => ({
    title: 'Update follow-up',
    lines: [
      ...(args.ownerId !== undefined ? [`owner → ${args.ownerId ?? 'unassigned'}`] : []),
      ...(args.nextAction !== undefined ? [`next action → ${args.nextAction ?? 'cleared'}`] : []),
      ...(args.nextActionAt !== undefined ? [`due → ${args.nextActionAt ?? 'cleared'}`] : []),
      ...(args.priority !== undefined ? [`priority → ${args.priority}`] : []),
    ],
  }),
  snapshot: async (args, context) =>
    (await readFollowup(context.database, args.organizationId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const saved = await updateProspectFollowupAction(
      {
        organizationId: args.organizationId,
        expectedVersion: args.expectedVersion,
        ...(args.ownerId !== undefined ? { ownerId: args.ownerId } : {}),
        ...(args.nextAction !== undefined ? { nextAction: args.nextAction } : {}),
        ...(args.nextActionAt !== undefined
          ? { nextActionAt: args.nextActionAt === null ? null : new Date(args.nextActionAt) }
          : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    const after = await readFollowup(context.database, args.organizationId)
    return {
      result: {
        organizationId: args.organizationId,
        version: after?.version ?? null,
        replayed: saved.replayed,
      },
      after: after as unknown as JsonValue,
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(context.operationId, 'followup'),
    )
    if (!receipt) return { state: 'not_applied' }
    const after = await readFollowup(context.database, args.organizationId)
    if (!after) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: { organizationId: args.organizationId, version: after.version, replayed: false },
        after: after as unknown as JsonValue,
      },
    }
  },
  /** Restores the values before the change, only if nothing else has touched the account since. */
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const before = original.beforeSnapshot as FollowupFields | null
    const after = original.afterSnapshot as FollowupFields | null
    const args = original.args as FollowupArgs
    if (!before || !after || after.version === null) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    await updateProspectFollowupAction(
      {
        organizationId: before.organizationId,
        expectedVersion: after.version,
        ...(args.ownerId !== undefined ? { ownerId: before.ownerId } : {}),
        ...(args.nextAction !== undefined ? { nextAction: before.nextAction } : {}),
        ...(args.nextActionAt !== undefined
          ? { nextActionAt: before.nextActionAt === null ? null : new Date(before.nextActionAt) }
          : {}),
        ...(args.priority !== undefined
          ? { priority: before.priority as 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' }
          : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    const now = await readFollowup(context.database, before.organizationId)
    return {
      result: { organizationId: before.organizationId, version: now?.version ?? null },
      after: now as unknown as JsonValue,
    }
  },
}

const noteInput = OPERATOR_MCP_INPUTS['crm.propose_note']
type NoteArgs = ReturnType<typeof noteInput.parse>

export const crmNoteKind: OperatorProposalKind<NoteArgs> = {
  kind: 'crm.note',
  tool: 'crm.propose_note',
  capability: 'crm:propose',
  parse: (raw) => noteInput.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const organization = await context.database.prospectOrganization.findFirst({
      where: { id: args.organizationId, archivedAt: null },
      select: { id: true },
    })
    if (!organization) throw new OperatorNotFoundError()
  },
  // Notes only add: there is no earlier state a note could conflict with.
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Add a note',
    lines: [args.note, ...(args.source ? [`source: ${args.source}`] : [])],
  }),
  snapshot: async (args) => ({ organizationId: args.organizationId }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const saved = await appendProspectNoteAction(
      {
        organizationId: args.organizationId,
        note: args.note,
        ...(args.source !== undefined ? { source: args.source } : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        noteId: saved.activity.id,
        organizationId: args.organizationId,
        replayed: saved.replayed,
      },
      after: { noteId: saved.activity.id },
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(context.operationId, 'note'),
    )
    if (!receipt) return { state: 'not_applied' }
    return {
      state: 'applied',
      outcome: {
        result: { noteId: receipt.id, organizationId: args.organizationId, replayed: false },
        after: { noteId: receipt.id },
      },
    }
  },
}

const accountArchiveInput = OPERATOR_MCP_INPUTS['crm.propose_account_archive']
type AccountArchiveArgs = ReturnType<typeof accountArchiveInput.parse>

async function readArchiveState(database: OperatorDatabase, organizationId: string) {
  const organization = await database.prospectOrganization.findUnique({
    where: { id: organizationId },
    select: { archivedAt: true },
  })
  if (!organization) return null
  return {
    organizationId,
    archived: organization.archivedAt !== null,
    version: await prospectOrganizationVersion(database, organizationId),
  }
}

export const crmAccountArchiveKind: OperatorProposalKind<AccountArchiveArgs> = {
  kind: 'crm.account-archive',
  tool: 'crm.propose_account_archive',
  capability: 'crm:propose',
  parse: (raw) => accountArchiveInput.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const state = await readArchiveState(context.database, args.organizationId)
    if (!state) throw new OperatorNotFoundError()
    // Archiving needs a live account and restoring needs an archived one; anything else is a no-op.
    if (state.archived === args.archived) throw new OperatorNotFoundError()
  },
  targetVersion: async (args) => String(args.expectedVersion),
  currentVersion: async (args, context) => {
    const version = await prospectOrganizationVersion(context.database, args.organizationId)
    return version === null ? null : String(version)
  },
  describe: (args) => ({
    title: args.archived
      ? 'Archive an account and its venues and contacts'
      : 'Restore an account and its venues and contacts',
    lines: [`organization ${args.organizationId}`, `reason: ${args.reason}`],
  }),
  snapshot: async (args, context) =>
    (await readArchiveState(context.database, args.organizationId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    await archiveProspectAction(
      {
        organizationId: args.organizationId,
        archived: args.archived,
        reason: args.reason,
        expectedVersion: args.expectedVersion,
        receiptKey: maintenanceReceiptKey(
          context.operationId,
          args.archived ? 'archive' : 'restore',
        ),
        actor: context.actor,
      },
      context.database,
    )
    const after = await readArchiveState(context.database, args.organizationId)
    return {
      result: {
        organizationId: args.organizationId,
        archived: after?.archived ?? args.archived,
        version: after?.version ?? null,
      },
      after: after as unknown as JsonValue,
    }
  },
  reconcile: async (args, context) => {
    const receipt = await receiptActivity(
      context.database,
      maintenanceReceiptKey(context.operationId, args.archived ? 'archive' : 'restore'),
    )
    if (!receipt) return { state: 'not_applied' }
    const after = await readArchiveState(context.database, args.organizationId)
    if (!after) return { state: 'unknown' }
    return {
      state: 'applied',
      outcome: {
        result: {
          organizationId: args.organizationId,
          archived: after.archived,
          version: after.version,
        },
        after: after as unknown as JsonValue,
      },
    }
  },
  revert: async (original: StoredOperatorProposal, context: OperatorApplyContext) => {
    const after = original.afterSnapshot as {
      organizationId?: string
      version?: number | null
    } | null
    const args = original.args as AccountArchiveArgs
    if (!after?.organizationId || after.version === null || after.version === undefined) {
      throw new OperatorStaleError('The original snapshot is incomplete.')
    }
    await archiveProspectAction(
      {
        organizationId: after.organizationId,
        archived: !args.archived,
        reason: `Reverted. ${operatorReason(original.id)}`,
        expectedVersion: after.version,
        receiptKey: maintenanceReceiptKey(
          context.operationId,
          args.archived ? 'restore' : 'archive',
        ),
        actor: context.actor,
      },
      context.database,
    )
    const now = await readArchiveState(context.database, after.organizationId)
    return {
      result: { organizationId: after.organizationId, archived: now?.archived ?? false },
      after: now as unknown as JsonValue,
    }
  },
}

export const CRM_MAINTENANCE_KINDS = [
  crmContactCreateKind,
  crmContactUpdateKind,
  crmContactArchiveKind,
  crmFollowupUpdateKind,
  crmNoteKind,
  crmAccountArchiveKind,
]
