import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  normalizeProspectDomain,
  normalizeProspectEmail,
  normalizeProspectName,
  prospectSha256,
  scoreProspectDuplicate,
} from './prospect-normalization'

export const PROSPECT_IMPORT_BATCH_MAX = 250
export const PROSPECT_IMPORT_COMMIT_BATCH_MAX = 100

export type ProspectActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
export type ProspectActionClient = typeof db
export type ProspectActionErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'UNSAFE_MERGE'

export class ProspectActionError extends Error {
  constructor(
    readonly code: ProspectActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProspectActionError'
  }
}

function requireActor(actor: ProspectActor): void {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id) {
    throw new ProspectActionError('INVALID_INPUT', 'A human platform administrator is required')
  }
}

function jsonValue(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

export type CreateProspectInput = {
  organization: {
    canonicalName: string
    aliases?: string[] | undefined
    website?: string | undefined
    organizationType?: string | undefined
    description?: string | undefined
    territoryId?: string | undefined
    source?: string | undefined
    ownerId?: string | undefined
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined
    notes?: string | undefined
    tags?: string[] | undefined
  }
  venue?:
    | {
        name: string
        website?: string | undefined
        venueType?: string | undefined
        city?: string | undefined
        region?: string | undefined
        country?: string | undefined
        notes?: string | undefined
      }
    | undefined
  contact?:
    | {
        fullName?: string | undefined
        title?: string | undefined
        email?: string | undefined
        phone?: string | undefined
        source?: string | undefined
        doNotContact?: boolean | undefined
        notes?: string | undefined
      }
    | undefined
  actor: ProspectActor
}

export async function createProspectAction(
  input: CreateProspectInput,
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  const canonicalName = input.organization.canonicalName.trim()
  if (!canonicalName)
    throw new ProspectActionError('INVALID_INPUT', 'Organization name is required')
  const normalizedName = normalizeProspectName(canonicalName)
  const normalizedDomain = normalizeProspectDomain(input.organization.website)
  const normalizedEmail = normalizeProspectEmail(input.contact?.email)

  return client.$transaction(async (tx) => {
    const matches = await tx.prospectOrganization.findMany({
      where: {
        archivedAt: null,
        OR: [
          { normalizedName },
          ...(normalizedDomain ? [{ normalizedDomain }] : []),
          ...(normalizedEmail ? [{ contacts: { some: { normalizedEmail } } }] : []),
        ],
      },
      select: { id: true, canonicalName: true, normalizedName: true, normalizedDomain: true },
      take: 10,
    })
    if (matches.length) {
      throw new ProspectActionError(
        'CONFLICT',
        'A possible matching prospect already exists; review duplicates before creating another.',
      )
    }
    const now = new Date()
    const organization = await tx.prospectOrganization.create({
      data: {
        canonicalName,
        normalizedName,
        aliases: input.organization.aliases ?? [],
        website: input.organization.website ?? null,
        normalizedDomain,
        organizationType: input.organization.organizationType ?? null,
        description: input.organization.description ?? null,
        territoryId: input.organization.territoryId ?? null,
        source: input.organization.source ?? null,
        ownerId: input.organization.ownerId ?? null,
        priority: input.organization.priority ?? 'NORMAL',
        notes: input.organization.notes ?? null,
        tags: input.organization.tags ?? [],
        createdBy: input.actor.id,
        updatedBy: input.actor.id,
        opportunity: {
          create: {
            source: input.organization.source ?? null,
            ownerId: input.organization.ownerId ?? null,
            priority: input.organization.priority ?? 'NORMAL',
            lastActivityAt: now,
            createdBy: input.actor.id,
            updatedBy: input.actor.id,
            stageHistory: {
              create: {
                toStage: 'DISCOVERED',
                reason: 'Prospect created',
                actorId: input.actor.id,
              },
            },
          },
        },
      },
    })
    const venue = input.venue
      ? await tx.prospectVenue.create({
          data: {
            organizationId: organization.id,
            territoryId: input.organization.territoryId ?? null,
            name: input.venue.name.trim(),
            normalizedName: normalizeProspectName(input.venue.name),
            website: input.venue.website ?? null,
            normalizedDomain: normalizeProspectDomain(input.venue.website),
            venueType: input.venue.venueType ?? null,
            city: input.venue.city ?? null,
            region: input.venue.region ?? null,
            country: input.venue.country ?? null,
            notes: input.venue.notes ?? null,
            lastActivityAt: now,
            createdBy: input.actor.id,
            updatedBy: input.actor.id,
          },
        })
      : null
    const contact = input.contact
      ? await tx.prospectContact.create({
          data: {
            organizationId: organization.id,
            venueId: venue?.id ?? null,
            fullName: input.contact.fullName ?? null,
            title: input.contact.title ?? null,
            email: input.contact.email ?? null,
            normalizedEmail,
            phone: input.contact.phone ?? null,
            source: input.contact.source ?? null,
            doNotContact: input.contact.doNotContact ?? false,
            notes: input.contact.notes ?? null,
            createdBy: input.actor.id,
            updatedBy: input.actor.id,
          },
        })
      : null
    await tx.prospectActivity.create({
      data: {
        organizationId: organization.id,
        venueId: venue?.id ?? null,
        contactId: contact?.id ?? null,
        type: 'DISCOVERED',
        summary: 'Prospect created',
        evidence: { source: input.organization.source ?? 'manual' },
        actorId: input.actor.id,
        occurredAt: now,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect.created',
        targetType: 'ProspectOrganization',
        targetId: organization.id,
        afterState: { organizationId: organization.id, venueId: venue?.id, contactId: contact?.id },
      },
      tx,
    )
    return { organization, venue, contact }
  })
}

export async function updateProspectPipelineAction(
  input: {
    organizationId: string
    stage:
      | 'DISCOVERED'
      | 'RESEARCHED'
      | 'NEEDS_REVIEW'
      | 'READY_FOR_OUTREACH'
      | 'CONTACTED'
      | 'FOLLOW_UP_DUE'
      | 'REPLIED'
      | 'CONVERSATION'
      | 'QUALIFIED'
      | 'PROPOSAL_DECISION'
      | 'WON'
      | 'LOST'
      | 'PARKED'
      | 'DO_NOT_CONTACT'
    priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | undefined
    ownerId?: string | null | undefined
    nextAction?: string | null | undefined
    nextActionAt?: Date | null | undefined
    reason?: string | undefined
    actor: ProspectActor
  },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (
    (input.stage === 'LOST' || input.stage === 'PARKED' || input.stage === 'DO_NOT_CONTACT') &&
    !input.reason?.trim()
  ) {
    throw new ProspectActionError('INVALID_INPUT', 'A reason is required for this stage')
  }
  return client.$transaction(async (tx) => {
    const before = await tx.prospectOpportunity.findUnique({
      where: { organizationId: input.organizationId },
    })
    if (!before) throw new ProspectActionError('NOT_FOUND', 'Prospect opportunity not found')
    const now = new Date()
    const saved = await tx.prospectOpportunity.update({
      where: { id: before.id },
      data: {
        stage: input.stage,
        priority: input.priority ?? before.priority,
        ownerId: input.ownerId === undefined ? before.ownerId : input.ownerId,
        nextAction: input.nextAction === undefined ? before.nextAction : input.nextAction,
        nextActionAt: input.nextActionAt === undefined ? before.nextActionAt : input.nextActionAt,
        lostParkedReason:
          input.stage === 'LOST' || input.stage === 'PARKED' || input.stage === 'DO_NOT_CONTACT'
            ? (input.reason ?? null)
            : null,
        lastActivityAt: now,
        updatedBy: input.actor.id,
      },
    })
    if (before.stage !== saved.stage) {
      await tx.prospectStageHistory.create({
        data: {
          opportunityId: saved.id,
          fromStage: before.stage,
          toStage: saved.stage,
          reason: input.reason ?? null,
          actorId: input.actor.id,
        },
      })
      await tx.prospectVenue.updateMany({
        where: { organizationId: input.organizationId, archivedAt: null },
        data: { stage: saved.stage, lastActivityAt: now, updatedBy: input.actor.id },
      })
    }
    await tx.prospectActivity.create({
      data: {
        organizationId: input.organizationId,
        type: before.stage === saved.stage ? 'NOTE_ADDED' : 'STAGE_CHANGED',
        summary:
          before.stage === saved.stage
            ? 'Pipeline details updated'
            : `Stage changed from ${before.stage} to ${saved.stage}`,
        detail: input.reason ?? null,
        evidence: { beforeStage: before.stage, afterStage: saved.stage },
        actorId: input.actor.id,
        occurredAt: now,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect.pipeline_updated',
        targetType: 'ProspectOpportunity',
        targetId: saved.id,
        beforeState: { stage: before.stage, priority: before.priority },
        afterState: { stage: saved.stage, priority: saved.priority },
      },
      tx,
    )
    return saved
  })
}

export async function addProspectNoteAction(
  input: { organizationId: string; note: string; actor: ProspectActor },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!input.note.trim()) throw new ProspectActionError('INVALID_INPUT', 'Note is required')
  return client.$transaction(async (tx) => {
    const organization = await tx.prospectOrganization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    })
    if (!organization) throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
    const activity = await tx.prospectActivity.create({
      data: {
        organizationId: organization.id,
        type: 'NOTE_ADDED',
        summary: 'Operator note added',
        detail: input.note.trim(),
        actorId: input.actor.id,
      },
    })
    await tx.prospectOpportunity.update({
      where: { organizationId: organization.id },
      data: { lastActivityAt: activity.occurredAt, updatedBy: input.actor.id },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect.note_added',
        targetType: 'ProspectOrganization',
        targetId: organization.id,
        afterState: { activityId: activity.id },
      },
      tx,
    )
    return activity
  })
}

export async function archiveProspectAction(
  input: { organizationId: string; archived: boolean; reason: string; actor: ProspectActor },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!input.reason.trim()) throw new ProspectActionError('INVALID_INPUT', 'Reason is required')
  return client.$transaction(async (tx) => {
    const before = await tx.prospectOrganization.findUnique({ where: { id: input.organizationId } })
    if (!before) throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
    const archivedAt = input.archived ? new Date() : null
    const organization = await tx.prospectOrganization.update({
      where: { id: input.organizationId },
      data: { archivedAt, updatedBy: input.actor.id },
    })
    await tx.prospectVenue.updateMany({
      where: { organizationId: input.organizationId },
      data: { archivedAt, updatedBy: input.actor.id },
    })
    await tx.prospectContact.updateMany({
      where: { organizationId: input.organizationId },
      data: { archivedAt, updatedBy: input.actor.id },
    })
    await tx.prospectActivity.create({
      data: {
        organizationId: input.organizationId,
        type: input.archived ? 'ARCHIVED' : 'RESTORED',
        summary: input.archived ? 'Prospect archived' : 'Prospect restored',
        detail: input.reason.trim(),
        actorId: input.actor.id,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: input.archived ? 'admin.prospect.archived' : 'admin.prospect.restored',
        targetType: 'ProspectOrganization',
        targetId: input.organizationId,
        beforeState: { archivedAt: before.archivedAt?.toISOString() ?? null },
        afterState: { archivedAt: organization.archivedAt?.toISOString() ?? null },
      },
      tx,
    )
    return organization
  })
}

export async function linkProspectConversionAction(
  input: {
    organizationId: string
    prospectVenueId?: string | undefined
    tenantId: string
    venueId?: string | undefined
    evidence?: Record<string, unknown> | undefined
    actor: ProspectActor
  },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  return client.$transaction(async (tx) => {
    const [organization, tenant, venue, existing] = await Promise.all([
      tx.prospectOrganization.findUnique({
        where: { id: input.organizationId },
        include: { opportunity: true },
      }),
      tx.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, name: true } }),
      input.venueId
        ? tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true, name: true },
          })
        : null,
      tx.prospectConversion.findUnique({ where: { organizationId: input.organizationId } }),
    ])
    if (!organization) throw new ProspectActionError('NOT_FOUND', 'Prospect not found')
    if (!tenant) throw new ProspectActionError('NOT_FOUND', 'Customer account not found')
    if (input.venueId && !venue)
      throw new ProspectActionError('INVALID_INPUT', 'Venue does not belong to the customer')
    if (input.prospectVenueId) {
      const prospectVenue = await tx.prospectVenue.findFirst({
        where: { id: input.prospectVenueId, organizationId: input.organizationId },
        select: { id: true },
      })
      if (!prospectVenue)
        throw new ProspectActionError('INVALID_INPUT', 'Prospect venue does not belong to prospect')
    }
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.venueId === (input.venueId ?? null)) {
        return { conversion: existing, replayed: true }
      }
      throw new ProspectActionError('CONFLICT', 'Prospect has already been converted')
    }
    const conversion = await tx.prospectConversion.create({
      data: {
        organizationId: input.organizationId,
        prospectVenueId: input.prospectVenueId ?? null,
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        actorId: input.actor.id,
        evidence: jsonValue(input.evidence ?? {}),
      },
    })
    if (organization.opportunity) {
      await tx.prospectOpportunity.update({
        where: { id: organization.opportunity.id },
        data: {
          stage: 'WON',
          lastActivityAt: conversion.convertedAt,
          updatedBy: input.actor.id,
        },
      })
      await tx.prospectStageHistory.create({
        data: {
          opportunityId: organization.opportunity.id,
          fromStage: organization.opportunity.stage,
          toStage: 'WON',
          reason: 'Converted to customer',
          actorId: input.actor.id,
          evidence: { conversionId: conversion.id },
        },
      })
    }
    await tx.prospectActivity.create({
      data: {
        organizationId: input.organizationId,
        venueId: input.prospectVenueId ?? null,
        type: 'CONVERTED_TO_CUSTOMER',
        summary: `Converted to customer ${tenant.name}`,
        evidence: {
          conversionId: conversion.id,
          tenantId: input.tenantId,
          venueId: input.venueId ?? null,
        },
        actorId: input.actor.id,
        occurredAt: conversion.convertedAt,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect.converted',
        targetType: 'ProspectConversion',
        targetId: conversion.id,
        afterState: {
          organizationId: input.organizationId,
          tenantId: input.tenantId,
          venueId: input.venueId ?? null,
        },
      },
      tx,
    )
    return { conversion, replayed: false }
  })
}

export type ProspectImportNormalizedRow = {
  organizationName?: string | undefined
  venueName: string
  venueType?: string | undefined
  venueSubtype?: string | undefined
  city?: string | undefined
  region?: string | undefined
  country?: string | undefined
  website?: string | undefined
  generalEmail?: string | undefined
  contactName?: string | undefined
  contactTitle?: string | undefined
  contactEmail?: string | undefined
  phone?: string | undefined
  ownerSize?: string | undefined
  locationCount?: string | undefined
  venueSize?: string | undefined
  shortDescription?: string | undefined
  fitScore?: string | undefined
  fitReason?: string | undefined
  primaryUseCase?: string | undefined
  outreachPriority?: string | undefined
  personalizationHook?: string | undefined
  researchConfidence?: string | undefined
  researchDate?: string | undefined
  sourceUrls?: string[] | undefined
  notes?: string | undefined
  territory?: string | undefined
}

export async function beginProspectImportAction(
  input: {
    fileName: string
    fileType: 'csv' | 'xlsx'
    fileSize: number
    fileHash: string
    mappingHash: string
    mapping: Record<string, unknown>
    sheets: Array<{
      sheetName: string
      sheetIndex: number
      detectedRows: number
      columns: string[]
    }>
    actor: ProspectActor
  },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!/^[a-f0-9]{64}$/.test(input.fileHash) || !/^[a-f0-9]{64}$/.test(input.mappingHash)) {
    throw new ProspectActionError('INVALID_INPUT', 'Import hashes must be SHA-256 values')
  }
  if (input.fileSize <= 0 || input.fileSize > 25 * 1024 * 1024) {
    throw new ProspectActionError('INVALID_INPUT', 'Spreadsheet must be between 1 byte and 25 MB')
  }
  if (!input.sheets.length || input.sheets.length > 100) {
    throw new ProspectActionError(
      'INVALID_INPUT',
      'Spreadsheet must contain 1 to 100 selected sheets',
    )
  }
  const importIdentityHash = prospectSha256({
    version: 1,
    fileHash: input.fileHash,
    mappingHash: input.mappingHash,
  })
  return client.$transaction(async (tx) => {
    const replay = await tx.prospectImport.findUnique({ where: { importIdentityHash } })
    if (replay) return { prospectImport: replay, replayed: true }
    const prospectImport = await tx.prospectImport.create({
      data: {
        fileName: input.fileName,
        fileType: input.fileType,
        fileSize: input.fileSize,
        fileHash: input.fileHash,
        mappingHash: input.mappingHash,
        importIdentityHash,
        mapping: jsonValue(input.mapping),
        createdBy: input.actor.id,
        sheets: {
          create: input.sheets.map((sheet) => ({
            sheetName: sheet.sheetName,
            sheetIndex: sheet.sheetIndex,
            detectedRows: sheet.detectedRows,
            columns: sheet.columns,
          })),
        },
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_import.started',
        targetType: 'ProspectImport',
        targetId: prospectImport.id,
        afterState: {
          fileName: input.fileName,
          fileHash: input.fileHash,
          selectedSheets: input.sheets.length,
        },
      },
      tx,
    )
    return { prospectImport, replayed: false }
  })
}

type StageImportRow = {
  sheetName: string
  originalRowNumber: number
  sourceValues: Record<string, unknown>
  normalizedValues: ProspectImportNormalizedRow
}

function validateImportRow(row: StageImportRow): {
  normalized: ProspectImportNormalizedRow & {
    normalizedOrganizationName: string
    normalizedVenueName: string
    normalizedDomain: string | null
    normalizedEmail: string | null
  }
  warnings: string[]
  errors: string[]
} {
  const warnings: string[] = []
  const errors: string[] = []
  const venueName = row.normalizedValues.venueName?.trim()
  if (!venueName) errors.push('venue-name-required')
  const organizationName = (row.normalizedValues.organizationName || venueName || '').trim()
  if (!organizationName) errors.push('organization-name-required')
  const normalizedDomain = normalizeProspectDomain(row.normalizedValues.website)
  if (row.normalizedValues.website && !normalizedDomain) warnings.push('website-invalid')
  const emailCandidate = row.normalizedValues.contactEmail || row.normalizedValues.generalEmail
  const normalizedEmail = normalizeProspectEmail(emailCandidate)
  if (emailCandidate && !normalizedEmail) warnings.push('email-invalid')
  if (!row.normalizedValues.website) warnings.push('website-missing')
  if (!row.normalizedValues.sourceUrls?.length) warnings.push('source-url-missing')
  return {
    normalized: {
      ...row.normalizedValues,
      organizationName,
      venueName: venueName || '',
      normalizedOrganizationName: normalizeProspectName(organizationName),
      normalizedVenueName: normalizeProspectName(venueName || ''),
      normalizedDomain,
      normalizedEmail,
    },
    warnings,
    errors,
  }
}

export async function stageProspectImportRowsAction(
  input: { importId: string; rows: StageImportRow[]; actor: ProspectActor },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!input.rows.length || input.rows.length > PROSPECT_IMPORT_BATCH_MAX) {
    throw new ProspectActionError(
      'INVALID_INPUT',
      `Import batches must contain 1 to ${PROSPECT_IMPORT_BATCH_MAX} rows`,
    )
  }
  return client.$transaction(async (tx) => {
    const prospectImport = await tx.prospectImport.findUnique({ where: { id: input.importId } })
    if (!prospectImport) throw new ProspectActionError('NOT_FOUND', 'Import not found')
    if (prospectImport.status !== 'DRAFT' && prospectImport.status !== 'DRY_RUN_READY') {
      throw new ProspectActionError('CONFLICT', 'Only a draft import can accept rows')
    }
    const allowedSheets = new Set(
      (
        await tx.prospectImportSheet.findMany({
          where: { importId: input.importId },
          select: { sheetName: true },
        })
      ).map((sheet) => sheet.sheetName),
    )
    let staged = 0
    for (const row of input.rows) {
      if (!allowedSheets.has(row.sheetName)) {
        throw new ProspectActionError('INVALID_INPUT', `Sheet is not selected: ${row.sheetName}`)
      }
      if (row.originalRowNumber < 2) {
        throw new ProspectActionError(
          'INVALID_INPUT',
          'Original row numbers must include the header offset',
        )
      }
      const existing = await tx.prospectImportRow.findUnique({
        where: {
          importId_sheetName_originalRowNumber: {
            importId: input.importId,
            sheetName: row.sheetName,
            originalRowNumber: row.originalRowNumber,
          },
        },
        select: { status: true },
      })
      if (existing?.status === 'IMPORTED') continue
      const checked = validateImportRow(row)
      const candidates = checked.errors.length
        ? []
        : await tx.prospectOrganization.findMany({
            where: {
              archivedAt: null,
              OR: [
                { normalizedName: checked.normalized.normalizedOrganizationName },
                ...(checked.normalized.normalizedDomain
                  ? [{ normalizedDomain: checked.normalized.normalizedDomain }]
                  : []),
                {
                  venues: {
                    some: {
                      normalizedName: checked.normalized.normalizedVenueName,
                      ...(checked.normalized.city ? { city: checked.normalized.city } : {}),
                    },
                  },
                },
                ...(checked.normalized.normalizedEmail
                  ? [
                      {
                        contacts: { some: { normalizedEmail: checked.normalized.normalizedEmail } },
                      },
                    ]
                  : []),
              ],
            },
            include: {
              venues: { select: { normalizedName: true, city: true }, take: 20 },
              contacts: { select: { normalizedEmail: true }, take: 20 },
            },
            take: 20,
          })
      const duplicateMatches = candidates
        .map((candidate) => {
          const venueMatch = candidate.venues.some(
            (venue) =>
              venue.normalizedName === checked.normalized.normalizedVenueName &&
              (!checked.normalized.city || venue.city === checked.normalized.city),
          )
          const scored = scoreProspectDuplicate({
            organizationName:
              candidate.normalizedName === checked.normalized.normalizedOrganizationName,
            venueName: venueMatch,
            domain:
              Boolean(checked.normalized.normalizedDomain) &&
              candidate.normalizedDomain === checked.normalized.normalizedDomain,
            contactEmail:
              Boolean(checked.normalized.normalizedEmail) &&
              candidate.contacts.some(
                (contact) => contact.normalizedEmail === checked.normalized.normalizedEmail,
              ),
          })
          return {
            organizationId: candidate.id,
            canonicalName: candidate.canonicalName,
            confidence: scored.confidence,
            reasons: scored.reasons,
          }
        })
        .filter((match) => match.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence)
      const status = checked.errors.length
        ? 'FAILED'
        : duplicateMatches.length
          ? 'DUPLICATE_REVIEW'
          : checked.warnings.length
            ? 'WARNING'
            : 'VALID'
      await tx.prospectImportRow.upsert({
        where: {
          importId_sheetName_originalRowNumber: {
            importId: input.importId,
            sheetName: row.sheetName,
            originalRowNumber: row.originalRowNumber,
          },
        },
        create: {
          importId: input.importId,
          sheetName: row.sheetName,
          originalRowNumber: row.originalRowNumber,
          rowFingerprint: prospectSha256(row.sourceValues),
          sourceValues: jsonValue(row.sourceValues),
          normalizedValues: jsonValue(checked.normalized),
          status,
          warnings: checked.warnings,
          errors: checked.errors,
          duplicateMatches,
        },
        update: {
          rowFingerprint: prospectSha256(row.sourceValues),
          sourceValues: jsonValue(row.sourceValues),
          normalizedValues: jsonValue(checked.normalized),
          status,
          warnings: checked.warnings,
          errors: checked.errors,
          duplicateMatches,
          errorCode: null,
          errorMessage: null,
        },
      })
      staged += 1
    }
    const counts = await tx.prospectImportRow.groupBy({
      by: ['status'],
      where: { importId: input.importId },
      _count: { _all: true },
    })
    const count = (status: string) =>
      counts.find((item) => item.status === status)?._count._all ?? 0
    const totalRows = counts.reduce((sum, item) => sum + item._count._all, 0)
    await tx.prospectImport.update({
      where: { id: input.importId },
      data: {
        status: 'DRY_RUN_READY',
        totalRows,
        validRows: count('VALID'),
        warningRows: count('WARNING'),
        duplicateRows: count('DUPLICATE_REVIEW'),
        failedRows: count('FAILED'),
      },
    })
    return { staged, totalRows, counts }
  })
}

export async function resolveProspectImportRowAction(
  input: {
    importId: string
    rowId: string
    decision: 'IMPORT_AS_DISTINCT' | 'SKIP'
    note: string
    actor: ProspectActor
  },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!input.note.trim()) throw new ProspectActionError('INVALID_INPUT', 'Review note is required')
  return client.$transaction(async (tx) => {
    const row = await tx.prospectImportRow.findFirst({
      where: { id: input.rowId, importId: input.importId },
    })
    if (!row) throw new ProspectActionError('NOT_FOUND', 'Import row not found')
    if (row.status !== 'DUPLICATE_REVIEW') {
      throw new ProspectActionError('CONFLICT', 'Only duplicate-review rows can be resolved')
    }
    const saved = await tx.prospectImportRow.update({
      where: { id: row.id },
      data: {
        status: input.decision === 'IMPORT_AS_DISTINCT' ? 'WARNING' : 'SKIPPED',
        warnings:
          input.decision === 'IMPORT_AS_DISTINCT'
            ? [
                ...(Array.isArray(row.warnings) ? row.warnings : []),
                `duplicate-reviewed-distinct:${input.note.trim()}`,
              ]
            : jsonValue(Array.isArray(row.warnings) ? row.warnings : []),
      },
    })
    const [warningRows, duplicateRows] = await Promise.all([
      tx.prospectImportRow.count({ where: { importId: input.importId, status: 'WARNING' } }),
      tx.prospectImportRow.count({
        where: { importId: input.importId, status: 'DUPLICATE_REVIEW' },
      }),
    ])
    await tx.prospectImport.update({
      where: { id: input.importId },
      data: { warningRows, duplicateRows },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_import.duplicate_reviewed',
        targetType: 'ProspectImportRow',
        targetId: row.id,
        beforeState: { status: row.status },
        afterState: { status: saved.status, decision: input.decision, note: input.note.trim() },
      },
      tx,
    )
    return saved
  })
}

export async function approveProspectImportAction(
  input: { importId: string; actor: ProspectActor },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  return client.$transaction(async (tx) => {
    const prospectImport = await tx.prospectImport.findUnique({ where: { id: input.importId } })
    if (!prospectImport) throw new ProspectActionError('NOT_FOUND', 'Import not found')
    if (prospectImport.status === 'APPROVED' || prospectImport.status === 'PROCESSING') {
      return { prospectImport, replayed: true }
    }
    if (prospectImport.status !== 'DRY_RUN_READY') {
      throw new ProspectActionError('CONFLICT', 'Import dry run is not ready')
    }
    const unresolvedDuplicates = await tx.prospectImportRow.count({
      where: { importId: input.importId, status: 'DUPLICATE_REVIEW' },
    })
    if (unresolvedDuplicates) {
      throw new ProspectActionError(
        'CONFLICT',
        `${unresolvedDuplicates} possible duplicate rows require an explicit review decision`,
      )
    }
    const importable = await tx.prospectImportRow.count({
      where: { importId: input.importId, status: { in: ['VALID', 'WARNING'] } },
    })
    if (!importable)
      throw new ProspectActionError('INVALID_INPUT', 'No validated rows are importable')
    const saved = await tx.prospectImport.update({
      where: { id: input.importId },
      data: { status: 'APPROVED', approvedBy: input.actor.id, approvedAt: new Date() },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_import.approved',
        targetType: 'ProspectImport',
        targetId: input.importId,
        afterState: { importableRows: importable },
      },
      tx,
    )
    return { prospectImport: saved, replayed: false }
  })
}

async function importOneProspectRow(
  importId: string,
  rowId: string,
  actor: ProspectActor,
  client: ProspectActionClient,
) {
  return client.$transaction(async (tx) => {
    const row = await tx.prospectImportRow.findUnique({ where: { id: rowId } })
    if (!row || row.importId !== importId)
      throw new ProspectActionError('NOT_FOUND', 'Import row not found')
    if (row.status === 'IMPORTED') return row
    if (row.status !== 'VALID' && row.status !== 'WARNING') {
      throw new ProspectActionError('CONFLICT', 'Import row is not approved for import')
    }
    const value = row.normalizedValues as ProspectImportNormalizedRow & {
      normalizedOrganizationName: string
      normalizedVenueName: string
      normalizedDomain: string | null
      normalizedEmail: string | null
    }
    const territoryName = value.territory?.trim() || row.sheetName
    const territoryCode = normalizeProspectName(territoryName).replace(/\s+/g, '-').slice(0, 80)
    const territory = await tx.prospectTerritory.upsert({
      where: { code: territoryCode },
      create: {
        name: territoryName,
        code: territoryCode,
        createdBy: actor.id,
        updatedBy: actor.id,
      },
      update: { name: territoryName, updatedBy: actor.id },
    })
    const importSource = `spreadsheet-import:${importId}`
    let organization = await tx.prospectOrganization.findFirst({
      where: {
        source: importSource,
        normalizedName: value.normalizedOrganizationName,
        archivedAt: null,
      },
    })
    if (!organization) {
      organization = await tx.prospectOrganization.create({
        data: {
          canonicalName: value.organizationName || value.venueName,
          normalizedName: value.normalizedOrganizationName,
          website: value.website ?? null,
          normalizedDomain: value.normalizedDomain,
          organizationType: value.venueType ?? null,
          description: value.shortDescription ?? null,
          headquartersCity: value.city ?? null,
          headquartersRegion: value.region ?? null,
          headquartersCountry: value.country ?? null,
          territoryId: territory.id,
          source: importSource,
          researchProvenance: value.sourceUrls ?? [],
          priority: value.outreachPriority?.toLowerCase() === 'high' ? 'HIGH' : 'NORMAL',
          notes: value.notes ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
          opportunity: {
            create: {
              stage: value.researchConfidence ? 'RESEARCHED' : 'DISCOVERED',
              source: importSource,
              priority: value.outreachPriority?.toLowerCase() === 'high' ? 'HIGH' : 'NORMAL',
              createdBy: actor.id,
              updatedBy: actor.id,
              stageHistory: {
                create: {
                  toStage: value.researchConfidence ? 'RESEARCHED' : 'DISCOVERED',
                  reason: 'Spreadsheet import',
                  actorId: actor.id,
                  evidence: { importId, importRowId: row.id },
                },
              },
            },
          },
        },
      })
    }
    let venue = await tx.prospectVenue.findFirst({
      where: {
        organizationId: organization.id,
        normalizedName: value.normalizedVenueName,
        city: value.city ?? null,
        archivedAt: null,
      },
    })
    if (!venue) {
      venue = await tx.prospectVenue.create({
        data: {
          organizationId: organization.id,
          territoryId: territory.id,
          name: value.venueName,
          normalizedName: value.normalizedVenueName,
          website: value.website ?? null,
          normalizedDomain: value.normalizedDomain,
          venueType: value.venueSubtype || value.venueType || null,
          city: value.city ?? null,
          region: value.region ?? null,
          country: value.country ?? null,
          estimatedSize: value.venueSize ?? null,
          fitAttributes: {
            ownerSize: value.ownerSize ?? null,
            locationCount: value.locationCount ?? null,
            fitScore: value.fitScore ?? null,
            fitReason: value.fitReason ?? null,
            primaryUseCase: value.primaryUseCase ?? null,
            personalizationHook: value.personalizationHook ?? null,
          },
          notes: value.notes ?? null,
          researchSources: value.sourceUrls ?? [],
          stage: value.researchConfidence ? 'RESEARCHED' : 'DISCOVERED',
          priority: value.outreachPriority?.toLowerCase() === 'high' ? 'HIGH' : 'NORMAL',
          sourceImportRowId: row.id,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
    }
    let contact = null
    const email = value.contactEmail || value.generalEmail
    if (value.contactName || email || value.phone) {
      contact = value.normalizedEmail
        ? await tx.prospectContact.findFirst({
            where: { organizationId: organization.id, normalizedEmail: value.normalizedEmail },
          })
        : null
      contact ??= await tx.prospectContact.create({
        data: {
          organizationId: organization.id,
          venueId: venue.id,
          fullName: value.contactName ?? null,
          title: value.contactTitle ?? null,
          email: email ?? null,
          normalizedEmail: value.normalizedEmail,
          phone: value.phone ?? null,
          source: importSource,
          provenance: value.sourceUrls ?? [],
          sourceImportRowId: row.id,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
      })
    }
    await tx.prospectSourceEvidence.create({
      data: {
        organizationId: organization.id,
        venueId: venue.id,
        contactId: contact?.id ?? null,
        sourceType: 'spreadsheet-row',
        sourceLabel: `${row.sheetName} row ${row.originalRowNumber}`,
        sourceUrl: value.sourceUrls?.[0] ?? null,
        capturedValue: jsonValue(row.sourceValues),
        importRowId: row.id,
        researchedAt: value.researchDate ? new Date(value.researchDate) : null,
        createdBy: actor.id,
      },
    })
    await tx.prospectActivity.create({
      data: {
        organizationId: organization.id,
        venueId: venue.id,
        contactId: contact?.id ?? null,
        type: 'IMPORTED',
        summary: `Imported from ${row.sheetName} row ${row.originalRowNumber}`,
        evidence: { importId, importRowId: row.id, rowFingerprint: row.rowFingerprint },
        actorId: actor.id,
      },
    })
    return tx.prospectImportRow.update({
      where: { id: row.id },
      data: {
        status: 'IMPORTED',
        importedOrganizationId: organization.id,
        importedVenueId: venue.id,
        importedContactId: contact?.id ?? null,
        processedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    })
  })
}

export async function commitProspectImportBatchAction(
  input: { importId: string; limit?: number | undefined; actor: ProspectActor },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  const limit = Math.min(
    Math.max(input.limit ?? PROSPECT_IMPORT_COMMIT_BATCH_MAX, 1),
    PROSPECT_IMPORT_COMMIT_BATCH_MAX,
  )
  const prospectImport = await client.prospectImport.findUnique({ where: { id: input.importId } })
  if (!prospectImport) throw new ProspectActionError('NOT_FOUND', 'Import not found')
  if (
    prospectImport.status !== 'APPROVED' &&
    prospectImport.status !== 'PROCESSING' &&
    prospectImport.status !== 'PARTIAL'
  ) {
    if (prospectImport.status === 'COMPLETE') {
      return { processed: 0, failed: 0, done: true, prospectImport }
    }
    throw new ProspectActionError('CONFLICT', 'Import has not been approved')
  }
  await client.prospectImport.update({
    where: { id: input.importId },
    data: { status: 'PROCESSING' },
  })
  const rows = await client.prospectImportRow.findMany({
    where: { importId: input.importId, status: { in: ['VALID', 'WARNING'] } },
    orderBy: [{ sheetName: 'asc' }, { originalRowNumber: 'asc' }],
    take: limit,
    select: { id: true },
  })
  let processed = 0
  let failed = 0
  for (const row of rows) {
    try {
      await importOneProspectRow(input.importId, row.id, input.actor, client)
      processed += 1
    } catch (error) {
      failed += 1
      await client.prospectImportRow.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          errorCode: error instanceof ProspectActionError ? error.code : 'UNEXPECTED',
          errorMessage:
            error instanceof Error ? error.message.slice(0, 500) : 'Unexpected import error',
          processedAt: new Date(),
        },
      })
    }
  }
  const counts = await client.prospectImportRow.groupBy({
    by: ['status'],
    where: { importId: input.importId },
    _count: { _all: true },
  })
  const count = (status: string) => counts.find((item) => item.status === status)?._count._all ?? 0
  const remaining = count('VALID') + count('WARNING')
  const terminalProblems = count('FAILED') + count('DUPLICATE_REVIEW') + count('SKIPPED')
  const status = remaining ? 'PROCESSING' : terminalProblems ? 'PARTIAL' : 'COMPLETE'
  const saved = await client.$transaction(async (tx) => {
    const updated = await tx.prospectImport.update({
      where: { id: input.importId },
      data: {
        status,
        importedRows: count('IMPORTED'),
        failedRows: count('FAILED'),
        duplicateRows: count('DUPLICATE_REVIEW'),
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_import.batch_committed',
        targetType: 'ProspectImport',
        targetId: input.importId,
        afterState: { processed, failed, remaining, status },
      },
      tx,
    )
    return updated
  })
  return { processed, failed, done: remaining === 0, prospectImport: saved, counts }
}

export async function resolveProspectDuplicateAction(
  input: {
    candidateId: string
    resolution: 'CONFIRMED_DUPLICATE' | 'CONFIRMED_DISTINCT' | 'DISMISSED'
    note: string
    actor: ProspectActor
  },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  if (!input.note.trim()) throw new ProspectActionError('INVALID_INPUT', 'Review note is required')
  if ((input.resolution as string) === 'MERGED') {
    throw new ProspectActionError('UNSAFE_MERGE', 'Destructive prospect merges are not enabled')
  }
  return client.$transaction(async (tx) => {
    const before = await tx.prospectDuplicateCandidate.findUnique({
      where: { id: input.candidateId },
    })
    if (!before) throw new ProspectActionError('NOT_FOUND', 'Duplicate candidate not found')
    if (before.status !== 'OPEN')
      throw new ProspectActionError('CONFLICT', 'Duplicate candidate is already resolved')
    const saved = await tx.prospectDuplicateCandidate.update({
      where: { id: before.id },
      data: {
        status: input.resolution,
        resolutionNote: input.note.trim(),
        reviewedBy: input.actor.id,
        reviewedAt: new Date(),
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_duplicate.reviewed',
        targetType: 'ProspectDuplicateCandidate',
        targetId: saved.id,
        beforeState: { status: before.status },
        afterState: { status: saved.status, note: input.note.trim() },
      },
      tx,
    )
    return saved
  })
}

export async function scanProspectDuplicatesAction(
  input: { actor: ProspectActor; prospectLimit?: number | undefined },
  client: ProspectActionClient = db,
) {
  requireActor(input.actor)
  const prospectLimit = Math.min(Math.max(input.prospectLimit ?? 20_000, 1), 20_000)
  const organizations = await client.prospectOrganization.findMany({
    where: { archivedAt: null },
    orderBy: { id: 'asc' },
    take: prospectLimit,
    select: {
      id: true,
      normalizedName: true,
      normalizedDomain: true,
      venues: { where: { archivedAt: null }, select: { normalizedName: true }, take: 20 },
      contacts: {
        where: { archivedAt: null, normalizedEmail: { not: null } },
        select: { normalizedEmail: true },
        take: 20,
      },
    },
  })
  const indexes = {
    organizationName: new Map<string, string[]>(),
    domain: new Map<string, string[]>(),
    venueName: new Map<string, string[]>(),
    contactEmail: new Map<string, string[]>(),
  }
  const append = (index: Map<string, string[]>, key: string | null, id: string) => {
    if (!key) return
    const values = index.get(key) ?? []
    if (values.length < 100) values.push(id)
    index.set(key, values)
  }
  for (const organization of organizations) {
    append(indexes.organizationName, organization.normalizedName, organization.id)
    append(indexes.domain, organization.normalizedDomain, organization.id)
    for (const venue of organization.venues)
      append(indexes.venueName, venue.normalizedName, organization.id)
    for (const contact of organization.contacts)
      append(indexes.contactEmail, contact.normalizedEmail, organization.id)
  }
  const pairSignals = new Map<
    string,
    { organizationName?: true; domain?: true; venueName?: true; contactEmail?: true }
  >()
  const collectPairs = (
    index: Map<string, string[]>,
    signal: 'organizationName' | 'domain' | 'venueName' | 'contactEmail',
  ) => {
    for (const ids of index.values()) {
      const unique = [...new Set(ids)]
      for (let left = 0; left < unique.length; left += 1) {
        for (let right = left + 1; right < unique.length; right += 1) {
          const a = unique[left]!
          const b = unique[right]!
          const [first, second] = a < b ? [a, b] : [b, a]
          const key = `${first}:${second}`
          pairSignals.set(key, { ...(pairSignals.get(key) ?? {}), [signal]: true })
          if (pairSignals.size >= 5_000) return
        }
      }
      if (pairSignals.size >= 5_000) return
    }
  }
  collectPairs(indexes.contactEmail, 'contactEmail')
  collectPairs(indexes.domain, 'domain')
  collectPairs(indexes.organizationName, 'organizationName')
  collectPairs(indexes.venueName, 'venueName')

  let created = 0
  let updated = 0
  await client.$transaction(async (tx) => {
    for (const [key, signals] of pairSignals) {
      const [organizationAId, organizationBId] = key.split(':') as [string, string]
      const scored = scoreProspectDuplicate(signals)
      if (scored.confidence < 0.72) continue
      const existing = await tx.prospectDuplicateCandidate.findUnique({
        where: { organizationAId_organizationBId: { organizationAId, organizationBId } },
        select: { id: true, status: true },
      })
      if (existing?.status && existing.status !== 'OPEN') continue
      await tx.prospectDuplicateCandidate.upsert({
        where: { organizationAId_organizationBId: { organizationAId, organizationBId } },
        create: {
          organizationAId,
          organizationBId,
          confidence: scored.confidence,
          reasons: scored.reasons,
        },
        update: { confidence: scored.confidence, reasons: scored.reasons },
      })
      if (existing) updated += 1
      else created += 1
    }
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'admin.prospect_duplicate.scan_completed',
        targetType: 'ProspectDuplicateCandidate',
        targetId: 'platform-prospect-scan',
        afterState: {
          organizationsScanned: organizations.length,
          candidatesCreated: created,
          candidatesUpdated: updated,
          truncated: organizations.length === prospectLimit || pairSignals.size === 5_000,
        },
      },
      tx,
    )
  })
  return {
    organizationsScanned: organizations.length,
    candidatesCreated: created,
    candidatesUpdated: updated,
    truncated: organizations.length === prospectLimit || pairSignals.size === 5_000,
  }
}
