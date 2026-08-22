import { createHash, randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = typeof db
type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
type JsonMap = Record<string, unknown>
type CommitTx = Pick<
  Client,
  | 'prospectOrganization'
  | 'prospectOpportunity'
  | 'prospectVenue'
  | 'prospectContact'
  | 'prospectSourceEvidence'
  | 'prospectCampaignMember'
  | 'prospectOutreachDraft'
  | 'prospectImportSourceRecord'
>
type ClaimedSourceRecord = Prisma.ProspectImportSourceRecordGetPayload<{
  include: { import: true }
}>
type SourceRecord = Prisma.ProspectImportSourceRecordGetPayload<object>

const KIND_ORDER = [
  'PROSPECT',
  'CONTACT',
  'EVIDENCE',
  'DRAFT',
  'DUPLICATE_REVIEW',
  'EXCEPTION',
  'RUN_LOG',
] as const

export class ProspectPackageCommitError extends Error {
  constructor(
    readonly code: 'APPROVAL_REQUIRED' | 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectPackageCommitError'
  }
}

function requireHuman(actor: HumanActor): void {
  if (!actor.id || actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectPackageCommitError('APPROVAL_REQUIRED', 'A human administrator is required')
  }
}

function object(value: unknown): JsonMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonMap) : {}
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${hash(parts.join('\n')).slice(0, 24)}`
}

function normalizedName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function normalizedDomain(value: string | null): string | null {
  if (!value) return null
  try {
    const host = new URL(value.includes('://') ? value : `https://${value}`).hostname
    return host.toLowerCase().replace(/^www\./u, '') || null
  } catch {
    return (
      value
        .toLowerCase()
        .replace(/^www\./u, '')
        .split('/')[0] || null
    )
  }
}

function manifest(importRecord: { packageManifest: unknown }): JsonMap {
  return object(importRecord.packageManifest)
}

export async function approveProspectStagingPackageCommitAction(
  input: { importId: string; actor: HumanActor },
  client: Client = db,
) {
  requireHuman(input.actor)
  return client.$transaction(async (tx) => {
    const source = await tx.prospectImport.findUnique({ where: { id: input.importId } })
    if (!source || !source.packageHash || !source.sourceWorkbookHash) {
      throw new ProspectPackageCommitError('NOT_FOUND', 'Admitted staging package not found')
    }
    if (!['DRAFT', 'PROCESSING', 'PARTIAL'].includes(source.status)) {
      throw new ProspectPackageCommitError('CONFLICT', 'Staging package cannot enter commit state')
    }
    const packageManifest = manifest(source)
    const packageId = text(packageManifest.packageId) ?? source.id
    const campaignId = stableId('pcampaign', source.packageHash)
    await tx.prospectOutreachCampaign.upsert({
      where: { id: campaignId },
      create: {
        id: campaignId,
        name: `Imported inert drafts: ${packageId}`.slice(0, 191),
        description:
          'Package-import holding campaign. Drafts require normal human review and release.',
        status: 'DRAFT',
        cohortSnapshot: {
          importId: source.id,
          packageHash: source.packageHash,
          sourceWorkbookHash: source.sourceWorkbookHash,
        },
        playbookVersion: text(object(packageManifest.lineage).promptVersion) ?? 'package-v1',
        createdBy: input.actor.id,
        updatedBy: input.actor.id,
      },
      update: {},
    })
    const approvedAt = new Date()
    const approved = await tx.prospectImport.update({
      where: { id: source.id },
      data: { status: 'PROCESSING', approvedBy: input.actor.id, approvedAt },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.staging-package.commit-approved',
        targetType: 'ProspectImport',
        targetId: source.id,
        beforeState: { status: source.status },
        afterState: { status: approved.status, packageHash: source.packageHash, campaignId },
      },
      tx,
    )
    return { importId: source.id, campaignId, status: approved.status }
  })
}

export async function claimProspectStagingPackageRecordsAction(
  input: { importId: string; workerId: string; limit?: number; leaseSeconds?: number; now?: Date },
  client: Client = db,
) {
  if (!input.workerId.trim())
    throw new ProspectPackageCommitError('INVALID_INPUT', 'Worker identity is required')
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(input.limit ?? 250, 500))
  const expiresAt = new Date(
    now.getTime() + Math.max(60, Math.min(input.leaseSeconds ?? 900, 1_800)) * 1_000,
  )
  const claimToken = randomUUID()
  return client.$transaction(async (tx) => {
    const source = await tx.prospectImport.findUnique({
      where: { id: input.importId },
      select: { status: true },
    })
    if (!source) throw new ProspectPackageCommitError('NOT_FOUND', 'Staging package not found')
    if (source.status !== 'PROCESSING') return null
    for (const recordKind of KIND_ORDER) {
      const candidates = await tx.prospectImportSourceRecord.findMany({
        where: {
          importId: input.importId,
          recordKind,
          OR: [
            { processingStatus: 'PENDING' },
            { processingStatus: 'PROCESSING', claimExpiresAt: { lt: now } },
          ],
        },
        orderBy: [{ externalRecordId: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: limit,
      })
      if (!candidates.length) continue
      await tx.prospectImportSourceRecord.updateMany({
        where: {
          id: { in: candidates.map((record) => record.id) },
          OR: [
            { processingStatus: 'PENDING' },
            { processingStatus: 'PROCESSING', claimExpiresAt: { lt: now } },
          ],
        },
        data: {
          processingStatus: 'PROCESSING',
          claimToken,
          claimOwner: input.workerId,
          claimExpiresAt: expiresAt,
          errorCode: null,
          errorMessage: null,
        },
      })
      const records = await tx.prospectImportSourceRecord.findMany({
        where: { claimToken, claimOwner: input.workerId },
        orderBy: [{ externalRecordId: 'asc' }, { id: 'asc' }],
      })
      if (records.length) return { claimToken, recordKind, expiresAt, records }
    }
    return null
  })
}

type CanonicalMapping = {
  recordType: string | null
  recordId: string | null
  organizationId: string | null
  venueId: string | null
  contactId: string | null
  evidenceId: string | null
  draftId: string | null
  processingStatus?: 'COMPLETE' | 'SKIPPED' | 'QUARANTINED'
}

async function mapProspect(record: ClaimedSourceRecord, tx: CommitTx): Promise<CanonicalMapping> {
  const raw = object(record.rawPayload)
  const normalized = object(record.normalizedPayload)
  const duplicateOutcome = (
    text(normalized.duplicateOutcome, raw.duplicateOutcome) ?? 'KEEP_DISTINCT'
  ).toUpperCase()
  if (duplicateOutcome === 'SKIP' || duplicateOutcome === 'QUARANTINE') {
    return {
      recordType: null,
      recordId: null,
      organizationId: null,
      venueId: null,
      contactId: null,
      evidenceId: null,
      draftId: null,
      processingStatus: duplicateOutcome === 'SKIP' ? 'SKIPPED' : 'QUARANTINED',
    }
  }
  if (!['LINK', 'UPDATE', 'KEEP_DISTINCT'].includes(duplicateOutcome)) {
    throw new ProspectPackageCommitError(
      'CONFLICT',
      `Unsupported duplicate outcome ${duplicateOutcome}`,
    )
  }
  const organizationName = text(
    normalized.organizationName,
    normalized.name,
    raw.Organization,
    raw.Name,
  )
  if (!organizationName)
    throw new ProspectPackageCommitError('INVALID_INPUT', 'Prospect organization name is required')
  const existingOrganizationId = text(normalized.existingOrganizationId)
  if (['LINK', 'UPDATE'].includes(duplicateOutcome) && !existingOrganizationId) {
    throw new ProspectPackageCommitError(
      'CONFLICT',
      `${duplicateOutcome} requires existingOrganizationId`,
    )
  }
  const organizationExternalId = text(normalized.organizationExternalId) ?? record.externalRecordId
  const organizationId =
    existingOrganizationId ?? stableId('porg', record.sourceWorkbookHash, organizationExternalId)
  const website = text(normalized.website, raw.Website)
  if (duplicateOutcome === 'LINK') {
    const exists = await tx.prospectOrganization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    })
    if (!exists)
      throw new ProspectPackageCommitError('NOT_FOUND', 'Linked organization does not exist')
  } else {
    await tx.prospectOrganization.upsert({
      where: { id: organizationId },
      create: {
        id: organizationId,
        canonicalName: organizationName,
        normalizedName: normalizedName(organizationName),
        website,
        normalizedDomain: text(normalized.domain) ?? normalizedDomain(website),
        organizationType: text(normalized.organizationType),
        headquartersCity: text(normalized.city),
        headquartersRegion: text(normalized.region),
        headquartersCountry: text(normalized.country),
        source: 'HERMES_STAGING',
        researchProvenance: [
          { importId: record.importId, externalRecordId: record.externalRecordId },
        ],
        createdBy: 'system:prospect-package-import',
        updatedBy: 'system:prospect-package-import',
      },
      update:
        duplicateOutcome === 'UPDATE'
          ? {
              canonicalName: organizationName,
              normalizedName: normalizedName(organizationName),
              website,
              normalizedDomain: text(normalized.domain) ?? normalizedDomain(website),
              updatedBy: 'system:prospect-package-import',
            }
          : {},
    })
  }
  await tx.prospectOpportunity.upsert({
    where: { organizationId },
    create: {
      organizationId,
      source: 'HERMES_STAGING',
      createdBy: 'system:prospect-package-import',
      updatedBy: 'system:prospect-package-import',
    },
    update: {},
  })
  const existingVenueId = text(normalized.existingVenueId)
  const venueId =
    existingVenueId ?? stableId('pvenue', record.sourceWorkbookHash, record.externalRecordId)
  const venueName =
    text(normalized.venueName, normalized.name, raw.Venue, raw.Name) ?? organizationName
  if (existingVenueId) {
    const venue = await tx.prospectVenue.findFirst({
      where: { id: existingVenueId, organizationId },
      select: { id: true },
    })
    if (!venue)
      throw new ProspectPackageCommitError(
        'NOT_FOUND',
        'Linked venue does not exist under the organization',
      )
  } else {
    await tx.prospectVenue.upsert({
      where: { id: venueId },
      create: {
        id: venueId,
        organizationId,
        name: venueName,
        normalizedName: normalizedName(venueName),
        website,
        normalizedDomain: text(normalized.domain) ?? normalizedDomain(website),
        venueType: text(normalized.venueType),
        addressLine1: text(normalized.addressLine1, raw.Address),
        city: text(normalized.city, raw.City),
        region: text(normalized.region, raw.State, raw.Region),
        postalCode: text(normalized.postalCode, raw.PostalCode),
        country: text(normalized.country, raw.Country),
        fitAttributes: json(object(normalized.fitAttributes)),
        researchSources: [{ importId: record.importId, externalRecordId: record.externalRecordId }],
        createdBy: 'system:prospect-package-import',
        updatedBy: 'system:prospect-package-import',
      },
      update: {},
    })
  }
  return {
    recordType: 'ProspectVenue',
    recordId: venueId,
    organizationId,
    venueId,
    contactId: null,
    evidenceId: null,
    draftId: null,
  }
}

async function parentRecord(record: ClaimedSourceRecord, tx: CommitTx): Promise<SourceRecord> {
  if (!record.parentExternalId)
    throw new ProspectPackageCommitError(
      'INVALID_INPUT',
      `${record.recordKind} requires parentExternalId`,
    )
  const parent = await tx.prospectImportSourceRecord.findFirst({
    where: { importId: record.importId, externalRecordId: record.parentExternalId },
  })
  if (!parent || !['COMPLETE', 'SKIPPED'].includes(parent.processingStatus)) {
    throw new ProspectPackageCommitError('CONFLICT', 'Parent record is not canonically committed')
  }
  return parent
}

async function mapContact(record: ClaimedSourceRecord, tx: CommitTx): Promise<CanonicalMapping> {
  const parent = await parentRecord(record, tx)
  if (!parent.canonicalOrganizationId)
    throw new ProspectPackageCommitError('CONFLICT', 'Contact parent has no organization mapping')
  const raw = object(record.rawPayload)
  const normalized = object(record.normalizedPayload)
  const contactId = stableId('pcontact', record.sourceWorkbookHash, record.externalRecordId)
  const email = text(normalized.email, raw.Email)?.toLowerCase() ?? null
  await tx.prospectContact.upsert({
    where: { id: contactId },
    create: {
      id: contactId,
      organizationId: parent.canonicalOrganizationId,
      venueId: parent.canonicalVenueId,
      fullName: text(normalized.fullName, normalized.name, raw.Contact, raw.Name),
      title: text(normalized.title, raw.Title),
      email,
      normalizedEmail: email,
      phone: text(normalized.phone, raw.Phone),
      source: 'HERMES_STAGING',
      provenance: [{ importId: record.importId, externalRecordId: record.externalRecordId }],
      emailReadiness: email ? 'REVIEW_REQUIRED' : 'UNKNOWN',
      permissionState: 'REVIEW_REQUIRED',
      createdBy: 'system:prospect-package-import',
      updatedBy: 'system:prospect-package-import',
    },
    update: {},
  })
  return {
    recordType: 'ProspectContact',
    recordId: contactId,
    organizationId: parent.canonicalOrganizationId,
    venueId: parent.canonicalVenueId,
    contactId,
    evidenceId: null,
    draftId: null,
  }
}

async function mapEvidence(record: ClaimedSourceRecord, tx: CommitTx): Promise<CanonicalMapping> {
  const parent = await parentRecord(record, tx)
  if (!parent.canonicalOrganizationId)
    throw new ProspectPackageCommitError('CONFLICT', 'Evidence parent has no organization mapping')
  const raw = object(record.rawPayload)
  const normalized = object(record.normalizedPayload)
  const evidenceId = stableId('pevidence', record.sourceWorkbookHash, record.externalRecordId)
  await tx.prospectSourceEvidence.upsert({
    where: { id: evidenceId },
    create: {
      id: evidenceId,
      organizationId: parent.canonicalOrganizationId,
      venueId: parent.canonicalVenueId,
      contactId: parent.canonicalContactId,
      sourceType:
        text(normalized.sourceType, raw.sourceType, record.sourceStatus) ?? 'STAGING_PACKAGE',
      sourceUrl: text(normalized.url, raw.url, raw.URL),
      sourceLabel: text(normalized.label, raw.label),
      capturedValue: json({ raw, normalized, importSourceRecordId: record.id }),
      researchedAt: text(normalized.researchedAt) ? new Date(text(normalized.researchedAt)!) : null,
      createdBy: 'system:prospect-package-import',
    },
    update: {},
  })
  return {
    recordType: 'ProspectSourceEvidence',
    recordId: evidenceId,
    organizationId: parent.canonicalOrganizationId,
    venueId: parent.canonicalVenueId,
    contactId: parent.canonicalContactId,
    evidenceId,
    draftId: null,
  }
}

async function mapDraft(record: ClaimedSourceRecord, tx: CommitTx): Promise<CanonicalMapping> {
  const parent = await parentRecord(record, tx)
  const metadata = object(record.recordMetadata)
  if (metadata.humanReviewStatus !== 'NOT_REVIEWED' || metadata.sendAuthority !== 'NONE') {
    throw new ProspectPackageCommitError(
      'CONFLICT',
      'Imported draft must remain unreviewed and have no send authority',
    )
  }
  let contactId = parent.canonicalContactId as string | null
  let organizationId = parent.canonicalOrganizationId as string | null
  let venueId = parent.canonicalVenueId as string | null
  if (!contactId) {
    const contactRecord = await tx.prospectImportSourceRecord.findFirst({
      where: {
        importId: record.importId,
        recordKind: 'CONTACT',
        parentExternalId: parent.externalRecordId,
        processingStatus: 'COMPLETE',
        canonicalContactId: { not: null },
      },
      orderBy: [{ externalRecordId: 'asc' }, { id: 'asc' }],
    })
    contactId = contactRecord?.canonicalContactId ?? null
    organizationId = organizationId ?? contactRecord?.canonicalOrganizationId ?? null
    venueId = venueId ?? contactRecord?.canonicalVenueId ?? null
  }
  if (!contactId || !organizationId)
    throw new ProspectPackageCommitError('CONFLICT', 'Draft has no committed contact')
  const contact = await tx.prospectContact.findUnique({ where: { id: contactId } })
  const raw = object(record.rawPayload)
  const normalized = object(record.normalizedPayload)
  const toEmail = text(normalized.toEmail, raw.toEmail, contact?.normalizedEmail)?.toLowerCase()
  const subject = text(normalized.subject, raw.subject)
  const textBody = text(normalized.textBody, normalized.body, raw.textBody, raw.body)
  const version = typeof metadata.draftVersion === 'number' ? metadata.draftVersion : 1
  if (!toEmail || !subject || !textBody || !contact) {
    throw new ProspectPackageCommitError(
      'INVALID_INPUT',
      'Draft requires contact email, subject, and text body',
    )
  }
  const packageHash = record.import.packageHash
  if (!packageHash) throw new ProspectPackageCommitError('CONFLICT', 'Package hash is missing')
  const campaignId = stableId('pcampaign', packageHash)
  const memberId = stableId('pmember', campaignId, contactId)
  await tx.prospectCampaignMember.upsert({
    where: { id: memberId },
    create: {
      id: memberId,
      campaignId,
      organizationId,
      venueId,
      contactId,
      status: 'NEEDS_REVIEW',
      selection: { importId: record.importId },
    },
    update: {},
  })
  const draftId = stableId('pdraft', record.sourceWorkbookHash, record.externalRecordId)
  const evidenceIds = Array.isArray(metadata.supportingEvidenceIds)
    ? metadata.supportingEvidenceIds.filter((value): value is string => typeof value === 'string')
    : []
  await tx.prospectOutreachDraft.upsert({
    where: { id: draftId },
    create: {
      id: draftId,
      campaignId,
      memberId,
      organizationId,
      venueId,
      contactId,
      version,
      status: 'NEEDS_REVIEW',
      toEmail,
      subject,
      textBody,
      contentHash: hash(`${toEmail}\n${subject}\n${textBody}\n`),
      groundingSnapshot: {
        importId: record.importId,
        importSourceRecordId: record.id,
        supportingEvidenceIds: evidenceIds,
      },
      escalationFlags: ['IMPORTED_INERT_DRAFT'],
      generatedByType: 'AGENT',
      generatedById: text(object(manifest(record.import).lineage).runId) ?? 'hermes-staging',
    },
    update: {},
  })
  return {
    recordType: 'ProspectOutreachDraft',
    recordId: draftId,
    organizationId,
    venueId,
    contactId,
    evidenceId: null,
    draftId,
  }
}

async function processRecord(record: ClaimedSourceRecord, tx: CommitTx): Promise<CanonicalMapping> {
  if (record.recordKind === 'PROSPECT') return mapProspect(record, tx)
  if (record.recordKind === 'CONTACT') return mapContact(record, tx)
  if (record.recordKind === 'EVIDENCE') return mapEvidence(record, tx)
  if (record.recordKind === 'DRAFT') return mapDraft(record, tx)
  return {
    recordType: null,
    recordId: null,
    organizationId: null,
    venueId: null,
    contactId: null,
    evidenceId: null,
    draftId: null,
  }
}

export async function commitProspectStagingPackageClaimAction(
  input: { claimToken: string; workerId: string; now?: Date },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  const records = await client.prospectImportSourceRecord.findMany({
    where: {
      claimToken: input.claimToken,
      claimOwner: input.workerId,
      processingStatus: 'PROCESSING',
    },
    orderBy: [{ externalRecordId: 'asc' }, { id: 'asc' }],
    include: { import: true },
  })
  let processed = 0
  let failed = 0
  for (const source of records) {
    try {
      await client.$transaction(async (tx) => {
        const live = await tx.prospectImportSourceRecord.findUnique({
          where: { id: source.id },
          include: { import: true },
        })
        if (
          !live ||
          live.claimToken !== input.claimToken ||
          live.claimOwner !== input.workerId ||
          live.processingStatus !== 'PROCESSING' ||
          !live.claimExpiresAt ||
          live.claimExpiresAt <= now
        ) {
          throw new ProspectPackageCommitError('CONFLICT', 'Source-record lease is no longer live')
        }
        const mapping = await processRecord(live, tx)
        const completed = await tx.prospectImportSourceRecord.updateMany({
          where: {
            id: live.id,
            claimToken: input.claimToken,
            claimOwner: input.workerId,
            processingStatus: 'PROCESSING',
            claimExpiresAt: { gt: now },
          },
          data: {
            processingStatus: mapping.processingStatus ?? 'COMPLETE',
            claimToken: null,
            claimOwner: null,
            claimExpiresAt: null,
            canonicalRecordType: mapping.recordType,
            canonicalRecordId: mapping.recordId,
            canonicalOrganizationId: mapping.organizationId,
            canonicalVenueId: mapping.venueId,
            canonicalContactId: mapping.contactId,
            canonicalEvidenceId: mapping.evidenceId,
            canonicalDraftId: mapping.draftId,
            processedAt: now,
          },
        })
        if (completed.count !== 1)
          throw new ProspectPackageCommitError(
            'CONFLICT',
            'Source-record lease changed during commit',
          )
      })
      processed += 1
    } catch (error) {
      failed += 1
      await client.prospectImportSourceRecord.updateMany({
        where: {
          id: source.id,
          claimToken: input.claimToken,
          claimOwner: input.workerId,
          processingStatus: 'PROCESSING',
        },
        data: {
          processingStatus: 'FAILED',
          claimToken: null,
          claimOwner: null,
          claimExpiresAt: null,
          errorCode: error instanceof ProspectPackageCommitError ? error.code : 'COMMIT_FAILED',
          errorMessage: (error instanceof Error
            ? error.message
            : 'Unknown staging record failure'
          ).slice(0, 2_000),
          processedAt: now,
        },
      })
    }
  }
  return { claimToken: input.claimToken, attempted: records.length, processed, failed }
}

export async function finalizeProspectStagingPackageAction(
  input: { importId: string; now?: Date },
  client: Client = db,
) {
  const now = input.now ?? new Date()
  return client.$transaction(async (tx) => {
    const source = await tx.prospectImport.findUnique({ where: { id: input.importId } })
    if (!source) throw new ProspectPackageCommitError('NOT_FOUND', 'Staging package not found')
    const rows = await tx.prospectImportSourceRecord.groupBy({
      by: ['recordKind', 'processingStatus'],
      where: { importId: input.importId },
      _count: { _all: true },
    })
    const unfinished = rows
      .filter((row) => ['PENDING', 'PROCESSING'].includes(row.processingStatus))
      .reduce((sum, row) => sum + row._count._all, 0)
    if (unfinished) return { finalized: false, unfinished, status: source.status }
    const failed = rows
      .filter((row) => ['FAILED', 'QUARANTINED'].includes(row.processingStatus))
      .reduce((sum, row) => sum + row._count._all, 0)
    const imported = rows
      .filter((row) => row.processingStatus === 'COMPLETE')
      .reduce((sum, row) => sum + row._count._all, 0)
    const skipped = rows
      .filter((row) => row.processingStatus === 'SKIPPED')
      .reduce((sum, row) => sum + row._count._all, 0)
    const errors = await tx.prospectImportSourceRecord.findMany({
      where: { importId: input.importId, processingStatus: { in: ['FAILED', 'QUARANTINED'] } },
      orderBy: [{ recordKind: 'asc' }, { externalRecordId: 'asc' }],
      select: { recordKind: true, externalRecordId: true, errorCode: true, errorMessage: true },
      take: 1_000,
    })
    const reconciliation = {
      total: source.totalRows,
      sourceRecords: rows.reduce((sum, row) => sum + row._count._all, 0),
      imported,
      skipped,
      failed,
      byKindAndStatus: rows,
      errors,
      truncatedErrors: failed > errors.length,
    }
    const completed = await tx.prospectImport.update({
      where: { id: source.id },
      data: {
        status: failed ? 'PARTIAL' : 'COMPLETE',
        importedRows: imported,
        failedRows: failed,
        reconciliation,
        completedAt: now,
        progressCursor: 'COMPLETE',
      },
    })
    return { finalized: true, unfinished: 0, status: completed.status, reconciliation }
  })
}
