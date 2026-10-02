import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  approveProspectImportAction,
  changeProspectContactAddressAction,
  createProspectForOperatorAction,
  findProspectCreateReceipt,
  findProspectDuplicateMatches,
  isAddressBlockedAnywhere,
  isProspectContactPersonBlocked,
  maintenanceReceiptKey,
  normalizeProspectDomain,
  normalizeProspectEmail,
  normalizeProspectName,
  ProspectActionError,
  readProspectAccountView,
  resolveProspectOwner,
  updateProspectAccountAction,
} from '@pathfinder/db'
import { enqueueProspectImportCommit } from '@pathfinder/jobs'

import type { OperatorDatabase } from '../audit'
import { computeImportPlan } from '../crm-import-plan'
import { OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorApplyContext,
  type OperatorKindContext,
  type OperatorProposalKind,
} from '../proposals'

/**
 * Account edits, address changes, prospect creation and import commits. Each uses the canonical db
 * action (or the existing admin import service) that compare-and-swaps what it changes and leaves a
 * unique receipt, so a retry or an interrupted apply settles from that receipt without repeating.
 * Refusals that need a person carry a stable code and non-sensitive `details`.
 */

/** A refusal the caller sees by name, with structured detail (current state, matches). */
function refusal(code: string, message: string, details?: JsonValue) {
  return Object.assign(new Error(message), { code, ...(details !== undefined ? { details } : {}) })
}

const iso = (value: Date) => value.toISOString()

type OwnerArg = { userId?: string | undefined; email?: string | undefined }

/** Resolves an owner through the user directory. Undefined stays unchanged; null clears. */
async function resolveOwnerId(
  database: OperatorDatabase,
  owner: OwnerArg | null | undefined,
): Promise<string | null | undefined> {
  if (owner === undefined) return undefined
  if (owner === null) return null
  const found = await resolveProspectOwner(
    database,
    owner.userId !== undefined ? { userId: owner.userId } : { email: owner.email ?? '' },
  )
  if (!found) {
    throw refusal('OWNER_NOT_FOUND', 'No user in the directory matches that owner.')
  }
  return found.id
}

// ---------------------------------------------------------------------------
// Account field edits
// ---------------------------------------------------------------------------

const accountUpdateInput = OPERATOR_MCP_INPUTS['crm.propose_account_update']
type AccountUpdateArgs = ReturnType<typeof accountUpdateInput.parse>

export const crmAccountUpdateKind: OperatorProposalKind<AccountUpdateArgs> = {
  kind: 'crm.account-update',
  tool: 'crm.propose_account_update',
  capability: 'crm:propose',
  parse: (raw) => accountUpdateInput.parse(raw),
  target: (args) => ({ ref: args.organizationId }),
  authorize: async (args, context: OperatorKindContext) => {
    const view = await readProspectAccountView(context.database, args.organizationId)
    if (!view || view.archived) throw new OperatorNotFoundError()
    await resolveOwnerId(context.database, args.owner)
    const wrongTime =
      args.expectedUpdatedAt !== undefined &&
      new Date(args.expectedUpdatedAt).toISOString() !== view.updatedAt
    if (view.version !== args.expectedVersion || wrongTime) {
      // The proposer gets the account as it is now, so it can propose again without another read.
      throw new OperatorStaleError(
        'The account changed since it was read.',
        view as unknown as JsonValue,
      )
    }
  },
  targetVersion: async (args) => String(args.expectedVersion),
  currentVersion: async (args, context) => {
    const view = await readProspectAccountView(context.database, args.organizationId)
    return view?.version === null || view?.version === undefined ? null : String(view.version)
  },
  describe: (args) => ({
    title: 'Edit account details',
    lines: [
      ...(args.name !== undefined ? [`name → ${args.name}`] : []),
      ...(args.website !== undefined ? [`website → ${args.website ?? 'cleared'}`] : []),
      ...(args.aliases !== undefined
        ? [`aliases → ${args.aliases.length ? args.aliases.join(', ') : 'cleared'}`]
        : []),
      ...(args.type !== undefined ? [`type → ${args.type ?? 'cleared'}`] : []),
      ...(args.city !== undefined ? [`city → ${args.city ?? 'cleared'}`] : []),
      ...(args.region !== undefined ? [`region → ${args.region ?? 'cleared'}`] : []),
      ...(args.country !== undefined ? [`country → ${args.country ?? 'cleared'}`] : []),
      ...(args.tags !== undefined
        ? [`tags → ${args.tags.length ? args.tags.join(', ') : 'cleared'}`]
        : []),
      ...(args.owner !== undefined
        ? [
            `owner → ${
              args.owner === null ? 'cleared' : (args.owner.userId ?? args.owner.email ?? '')
            }`,
          ]
        : []),
      `reason: ${args.reason}`,
    ],
  }),
  snapshot: async (args, context) =>
    (await readProspectAccountView(context.database, args.organizationId)) as unknown as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const ownerId = await resolveOwnerId(context.database, args.owner)
    let saved
    try {
      saved = await updateProspectAccountAction(
        {
          organizationId: args.organizationId,
          expectedVersion: args.expectedVersion,
          ...(args.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: new Date(args.expectedUpdatedAt) }
            : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.website !== undefined ? { website: args.website } : {}),
          ...(args.aliases !== undefined ? { aliases: args.aliases } : {}),
          ...(args.type !== undefined ? { organizationType: args.type } : {}),
          ...(args.city !== undefined ? { city: args.city } : {}),
          ...(args.region !== undefined ? { region: args.region } : {}),
          ...(args.country !== undefined ? { country: args.country } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(ownerId !== undefined ? { ownerId } : {}),
          operationKey: context.operationId,
          actor: context.actor,
        },
        context.database,
      )
    } catch (error) {
      if (error instanceof ProspectActionError && error.code === 'CONFLICT') {
        const current = await readProspectAccountView(context.database, args.organizationId)
        throw new OperatorStaleError(error.message, current as unknown as JsonValue)
      }
      throw error
    }
    return {
      result: {
        organizationId: args.organizationId,
        changedFields: saved.changes.map((change) => change.field),
        changes: saved.changes as unknown as JsonValue,
        account: saved.account as unknown as JsonValue,
        replayed: saved.replayed,
      },
      after: saved.account as unknown as JsonValue,
    }
  },
  reconcile: async (args, context) => {
    const receipt = await context.database.prospectActivity.findUnique({
      where: {
        externalReceiptKey: maintenanceReceiptKey(context.operationId, 'account-update'),
      },
      select: { evidence: true },
    })
    if (!receipt) return { state: 'not_applied' }
    const account = await readProspectAccountView(context.database, args.organizationId)
    if (!account) return { state: 'unknown' }
    const changes =
      (receipt.evidence as { changes?: Array<{ field: string }> } | null)?.changes ?? []
    return {
      state: 'applied',
      outcome: {
        result: {
          organizationId: args.organizationId,
          changedFields: changes.map((change) => change.field),
          changes: changes as unknown as JsonValue,
          account: account as unknown as JsonValue,
          replayed: false,
        },
        after: account as unknown as JsonValue,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Contact address change
// ---------------------------------------------------------------------------

const addressChangeInput = OPERATOR_MCP_INPUTS['crm.propose_contact_address_change']
type AddressChangeArgs = ReturnType<typeof addressChangeInput.parse>

async function readContactForChange(database: OperatorDatabase, contactId: string) {
  const contact = await database.prospectContact.findUnique({
    where: { id: contactId },
    select: {
      id: true,
      organizationId: true,
      archivedAt: true,
      updatedAt: true,
      doNotContact: true,
      unsubscribedAt: true,
      complainedAt: true,
      permissionState: true,
      suppressedAt: true,
      lastHardBounceAt: true,
      organization: { select: { archivedAt: true, opportunity: { select: { stage: true } } } },
    },
  })
  if (!contact || contact.organization.archivedAt) return null
  return contact
}

export const crmContactAddressChangeKind: OperatorProposalKind<AddressChangeArgs> = {
  kind: 'crm.contact-address-change',
  tool: 'crm.propose_contact_address_change',
  capability: 'crm:propose',
  parse: (raw) => addressChangeInput.parse(raw),
  target: (args) => ({ ref: args.contactId }),
  authorize: async (args, context: OperatorKindContext) => {
    const contact = await readContactForChange(context.database, args.contactId)
    if (!contact) throw new OperatorNotFoundError()
    if (contact.archivedAt) throw new OperatorNotFoundError()
    if (iso(contact.updatedAt) !== new Date(args.expectedUpdatedAt).toISOString()) {
      throw new OperatorStaleError('The contact changed since it was read.', {
        contactId: contact.id,
        updatedAt: iso(contact.updatedAt),
        archived: false,
      })
    }
    // Never a way around a suppression: a declined person, a do-not-contact account or a blocked
    // address stops here before anything is proposed.
    if (
      isProspectContactPersonBlocked(contact) ||
      contact.organization.opportunity?.stage === 'DO_NOT_CONTACT'
    ) {
      throw refusal(
        'DO_NOT_CONTACT_LOCKED',
        'This contact or account is suppressed; only a person can decide about a new address.',
      )
    }
    const normalized = normalizeProspectEmail(args.newEmail)
    if (normalized && (await isAddressBlockedAnywhere(context.database, normalized))) {
      throw refusal(
        'ADDRESS_SUPPRESSED',
        'The new address is blocked on an existing contact record and cannot be added.',
      )
    }
  },
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) => {
    const contact = await readContactForChange(context.database, args.contactId)
    return contact ? iso(contact.updatedAt) : null
  },
  describe: (args) => ({
    title: 'Move a contact to a new email address',
    lines: [
      `contact ${args.contactId}`,
      `new address: ${args.newEmail}`,
      args.retireOldAddress
        ? 'the old address is archived; its history and any block stay on it'
        : 'the old address stays active; its history and any block stay on it',
      'the new address starts unverified and is checked on its own',
      `reason: ${args.reason}`,
    ],
  }),
  snapshot: async (args, context) => {
    const contact = await readContactForChange(context.database, args.contactId)
    return (
      contact ? { contactId: contact.id, updatedAt: iso(contact.updatedAt), archived: false } : null
    ) as JsonValue
  },
  apply: async (args, context: OperatorApplyContext) => {
    let saved
    try {
      saved = await changeProspectContactAddressAction(
        {
          contactId: args.contactId,
          expectedUpdatedAt: new Date(args.expectedUpdatedAt),
          newEmail: args.newEmail,
          retireOldAddress: args.retireOldAddress,
          reason: args.reason,
          operationKey: context.operationId,
          actor: context.actor,
        },
        context.database,
      )
    } catch (error) {
      if (error instanceof ProspectActionError && error.code === 'CONFLICT') {
        const current = await readContactForChange(context.database, args.contactId)
        throw new OperatorStaleError(
          error.message,
          (current
            ? { contactId: current.id, updatedAt: iso(current.updatedAt) }
            : null) as JsonValue,
        )
      }
      throw error
    }
    return {
      result: {
        newContactId: saved.newContact.id,
        oldContactId: args.contactId,
        oldContactArchived: saved.oldContact?.archivedAt != null,
        // The old row is untouched apart from its provenance and optional archive.
        oldHistoryAndSuppressionKept: true,
        replayed: saved.replayed,
      },
      after: {
        contactId: saved.newContact.id,
        oldContactId: args.contactId,
        updatedAt: iso(saved.newContact.updatedAt),
      },
    }
  },
  reconcile: async (args, context) => {
    const receipt = await context.database.prospectActivity.findUnique({
      where: {
        externalReceiptKey: maintenanceReceiptKey(context.operationId, 'contact-address-change'),
      },
      select: { contactId: true },
    })
    if (!receipt) return { state: 'not_applied' }
    if (!receipt.contactId) return { state: 'unknown' }
    const created = await context.database.prospectContact.findUniqueOrThrow({
      where: { id: receipt.contactId },
      select: { id: true, updatedAt: true },
    })
    const old = await context.database.prospectContact.findUnique({
      where: { id: args.contactId },
      select: { archivedAt: true },
    })
    return {
      state: 'applied',
      outcome: {
        result: {
          newContactId: created.id,
          oldContactId: args.contactId,
          oldContactArchived: old?.archivedAt != null,
          oldHistoryAndSuppressionKept: true,
          replayed: false,
        },
        after: {
          contactId: created.id,
          oldContactId: args.contactId,
          updatedAt: iso(created.updatedAt),
        },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Prospect creation
// ---------------------------------------------------------------------------

const prospectCreateInput = OPERATOR_MCP_INPUTS['crm.propose_prospect_create']
type ProspectCreateArgs = ReturnType<typeof prospectCreateInput.parse>

async function duplicateStop(database: OperatorDatabase, args: ProspectCreateArgs) {
  const normalizedEmail = normalizeProspectEmail(args.contact?.email)
  const matches = await findProspectDuplicateMatches(database, {
    normalizedName: normalizeProspectName(args.organization.name),
    normalizedDomain: normalizeProspectDomain(args.organization.website),
    normalizedEmail,
  })
  if (matches.length > 0) {
    throw refusal(
      'DUPLICATE_REVIEW',
      'A matching account already exists; a person must review it before another is created.',
      { matches } as unknown as JsonValue,
    )
  }
  if (normalizedEmail && (await isAddressBlockedAnywhere(database, normalizedEmail))) {
    throw refusal(
      'ADDRESS_SUPPRESSED',
      'This address is blocked on an existing contact record and cannot be added again.',
    )
  }
}

export const crmProspectCreateKind: OperatorProposalKind<ProspectCreateArgs> = {
  kind: 'crm.prospect-create',
  tool: 'crm.propose_prospect_create',
  capability: 'crm:propose',
  parse: (raw) => prospectCreateInput.parse(raw),
  target: () => ({}),
  authorize: async (args, context: OperatorKindContext) => {
    await resolveOwnerId(context.database, args.organization.owner)
    await duplicateStop(context.database, args)
  },
  // A create has no earlier state to move under it; the apply transaction repeats the duplicate check.
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({
    title: 'Add a prospect (CRM records only: no customer, tenant or outreach)',
    lines: [
      `organization: ${args.organization.name}`,
      ...(args.organization.website ? [`website: ${args.organization.website}`] : []),
      ...(args.organization.type ? [`type: ${args.organization.type}`] : []),
      ...(args.organization.tags?.length ? [`tags: ${args.organization.tags.join(', ')}`] : []),
      ...(args.organization.owner
        ? [`owner: ${args.organization.owner.userId ?? args.organization.owner.email ?? ''}`]
        : []),
      ...(args.site ? [`site: ${args.site.name}`] : []),
      ...(args.contact
        ? [
            `contact: ${[args.contact.fullName, args.contact.email].filter(Boolean).join(' ')}`,
            'the contact starts unverified for sending',
          ]
        : []),
      'checked for an exact name, domain or address match first; a match stops for review',
      `source: ${args.source}`,
    ],
  }),
  snapshot: async (args) =>
    ({ normalizedName: normalizeProspectName(args.organization.name) }) as JsonValue,
  apply: async (args, context: OperatorApplyContext) => {
    const ownerId = await resolveOwnerId(context.database, args.organization.owner)
    const created = await createProspectForOperatorAction(
      {
        organization: {
          canonicalName: args.organization.name,
          ...(args.organization.aliases !== undefined
            ? { aliases: args.organization.aliases }
            : {}),
          ...(args.organization.website !== undefined
            ? { website: args.organization.website }
            : {}),
          ...(args.organization.type !== undefined
            ? { organizationType: args.organization.type }
            : {}),
          ...(args.organization.tags !== undefined ? { tags: args.organization.tags } : {}),
          ...(args.organization.notes !== undefined ? { notes: args.organization.notes } : {}),
          ...(typeof ownerId === 'string' ? { ownerId } : {}),
          source: args.source,
        },
        ...(args.site
          ? {
              venue: {
                name: args.site.name,
                ...(args.site.website !== undefined ? { website: args.site.website } : {}),
                ...(args.site.type !== undefined ? { venueType: args.site.type } : {}),
                ...(args.site.city !== undefined ? { city: args.site.city } : {}),
                ...(args.site.region !== undefined ? { region: args.site.region } : {}),
                ...(args.site.country !== undefined ? { country: args.site.country } : {}),
              },
            }
          : {}),
        ...(args.contact
          ? {
              contact: {
                ...(args.contact.fullName !== undefined ? { fullName: args.contact.fullName } : {}),
                ...(args.contact.title !== undefined ? { title: args.contact.title } : {}),
                ...(args.contact.email !== undefined ? { email: args.contact.email } : {}),
                ...(args.contact.phone !== undefined ? { phone: args.contact.phone } : {}),
                source: args.source,
              },
            }
          : {}),
        operationKey: context.operationId,
        actor: context.actor,
      },
      context.database,
    )
    return {
      result: {
        organizationId: created.organizationId,
        venueId: created.venueId,
        contactId: created.contactId,
        replayed: created.replayed,
        // Always false: this creates CRM records, never a customer or a tenant.
        customerCreated: false,
      },
      after: { organizationId: created.organizationId },
    }
  },
  reconcile: async (_args, context) => {
    const receipt = await findProspectCreateReceipt(context.database, context.operationId)
    if (!receipt) return { state: 'not_applied' }
    return {
      state: 'applied',
      outcome: {
        result: {
          organizationId: receipt.organizationId,
          venueId: receipt.venueId,
          contactId: receipt.contactId,
          replayed: false,
          customerCreated: false,
        },
        after: { organizationId: receipt.organizationId },
      },
    }
  },
}

// ---------------------------------------------------------------------------
// Import commit
// ---------------------------------------------------------------------------

const importCommitInput = OPERATOR_MCP_INPUTS['crm.propose_import_commit']
type ImportCommitArgs = ReturnType<typeof importCommitInput.parse>

/** Statuses from which a commit may still be signed off (the second finishes an interrupted one). */
const COMMITTABLE_STATUSES = new Set(['DRY_RUN_READY', 'APPROVED'])

async function loadImport(database: OperatorDatabase, importId: string) {
  return database.prospectImport.findUnique({
    where: { id: importId },
    select: {
      id: true,
      status: true,
      fileHash: true,
      mappingHash: true,
      progressCursor: true,
      sourceObjectKey: true,
      approvedAt: true,
    },
  })
}

export const crmImportCommitKind: OperatorProposalKind<ImportCommitArgs> = {
  kind: 'crm.import-commit',
  tool: 'crm.propose_import_commit',
  capability: 'crm:propose',
  parse: (raw) => importCommitInput.parse(raw),
  target: (args) => ({ ref: args.importId }),
  authorize: async (args, context: OperatorKindContext) => {
    const row = await loadImport(context.database, args.importId)
    if (!row) throw new OperatorNotFoundError()
    const plan = await computeImportPlan(context.database, row)
    const current = {
      importId: row.id,
      status: row.status,
      fileHash: row.fileHash,
      mappingHash: row.mappingHash,
      planHash: plan.planHash,
      importableRows: plan.importableRows,
      counts: plan.counts,
    } as unknown as JsonValue
    // The file, the mapping and every reviewed row are bound by hash: any drift is stale, and the
    // proposer gets the import as it is now.
    if (
      row.fileHash !== args.fileHash ||
      row.mappingHash !== args.mappingHash ||
      plan.planHash !== args.planHash
    ) {
      throw new OperatorStaleError('The import changed since it was read.', current)
    }
    if (!COMMITTABLE_STATUSES.has(row.status)) {
      throw refusal(
        'IMPORT_NOT_READY',
        `The import is ${row.status}, not ready to commit.`,
        current,
      )
    }
    if (row.sourceObjectKey && row.progressCursor !== 'DRY_RUN_READY') {
      throw refusal('IMPORT_NOT_READY', 'Workbook staging has not finished.', current)
    }
    if (plan.counts.DUPLICATE_REVIEW > 0) {
      throw refusal(
        'IMPORT_NOT_READY',
        `${plan.counts.DUPLICATE_REVIEW} possible duplicate rows still need a review decision in the admin app.`,
        current,
      )
    }
    if (plan.importableRows !== args.expectedRows || plan.importableRows === 0) {
      throw new OperatorStaleError(
        'The importable row count differs from the one proposed.',
        current,
      )
    }
  },
  targetVersion: async (args) => args.planHash,
  currentVersion: async (args, context) => {
    const row = await loadImport(context.database, args.importId)
    return row ? (await computeImportPlan(context.database, row)).planHash : null
  },
  describe: (args) => ({
    title: 'Commit a reviewed spreadsheet import',
    lines: [
      `import ${args.importId}`,
      `file ${args.fileHash.slice(0, 12)}, mapping ${args.mappingHash.slice(0, 12)}, plan ${args.planHash.slice(0, 12)}`,
      `${args.expectedRows} rows will be created or linked (duplicates were decided row by row)`,
      'signs the import off and queues the existing commit job; nothing is merged',
    ],
  }),
  snapshot: async (args, context) => {
    const row = await loadImport(context.database, args.importId)
    if (!row) return null
    const plan = await computeImportPlan(context.database, row)
    return {
      importId: row.id,
      status: row.status,
      planHash: plan.planHash,
      counts: plan.counts,
    } as unknown as JsonValue
  },
  apply: async (args, context: OperatorApplyContext) => {
    // Idempotent end to end: signing off an already signed-off import replays, and the job id is
    // fixed per import, so an interrupted apply can run again without a second commit.
    const approved = await approveProspectImportAction(
      { importId: args.importId, actor: context.actor },
      context.database,
    )
    await enqueueProspectImportCommit({ importId: args.importId })
    return {
      result: {
        importId: args.importId,
        status: approved.prospectImport.status,
        queued: true,
        rowsToCommit: args.expectedRows,
        replayed: approved.replayed,
      },
      after: { importId: args.importId, status: approved.prospectImport.status },
    }
  },
  /**
   * Still DRY_RUN_READY or APPROVED: the commit job has not begun, and applying again is safe (the
   * sign-off replays and the job id is fixed), so it is reported as not applied. Once the job has
   * started, the import is past the point of this proposal and is reported as applied.
   */
  reconcile: async (args, context) => {
    const row = await loadImport(context.database, args.importId)
    if (!row) return { state: 'unknown' }
    if (COMMITTABLE_STATUSES.has(row.status)) return { state: 'not_applied' }
    if (['PROCESSING', 'COMPLETE', 'PARTIAL'].includes(row.status) && row.approvedAt) {
      return {
        state: 'applied',
        outcome: {
          result: {
            importId: args.importId,
            status: row.status,
            queued: true,
            rowsToCommit: args.expectedRows,
            replayed: false,
          },
          after: { importId: args.importId, status: row.status },
        },
      }
    }
    return { state: 'unknown' }
  },
}

export const CRM_PROSPECT_ADMIN_KINDS = [
  crmAccountUpdateKind,
  crmContactAddressChangeKind,
  crmProspectCreateKind,
  crmImportCommitKind,
]
