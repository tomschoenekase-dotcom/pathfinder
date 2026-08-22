import { createHash } from 'node:crypto'

import {
  parseProspectStagingPackage,
  PROSPECT_STAGING_PACKAGE_SCHEMA,
} from '@pathfinder/contracts/prospect-staging-package'

import { db } from '../client'

type Client = typeof db
type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }

export class ProspectPackageAdmissionError extends Error {
  constructor(
    readonly code: 'APPROVAL_REQUIRED' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectPackageAdmissionError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

/**
 * Admits package identity and immutable source-record lineage only. It creates no canonical
 * prospects, drafts, send batches, outbox operations, or email messages.
 */
export async function admitProspectStagingPackageAction(
  input: { package: unknown; actor: HumanActor },
  client: Client = db,
) {
  if (!input.actor.id || input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectPackageAdmissionError(
      'APPROVAL_REQUIRED',
      'A human platform administrator is required to admit a staging package',
    )
  }
  const parsed = parseProspectStagingPackage(input.package)
  const identityHash = sha256(
    `${PROSPECT_STAGING_PACKAGE_SCHEMA}\n${parsed.package.sourceWorkbook.sha256}\n${parsed.packageHash}`,
  )
  return client.$transaction(async (tx) => {
    const replay = await tx.prospectImport.findUnique({
      where: { importIdentityHash: identityHash },
      include: { _count: { select: { sourceRecords: true } } },
    })
    if (replay) {
      if (
        replay.packageHash !== parsed.packageHash ||
        replay._count.sourceRecords !== parsed.package.records.length
      ) {
        throw new ProspectPackageAdmissionError(
          'CONFLICT',
          'Existing package identity does not match its immutable admitted records',
        )
      }
      return {
        importId: replay.id,
        packageHash: parsed.packageHash,
        sourceRecordCount: replay._count.sourceRecords,
        replayed: true,
      }
    }
    const prospectImport = await tx.prospectImport.create({
      data: {
        fileName: `${parsed.package.packageId}.json`,
        fileType: 'torchiko-prospect-staging-package-v1',
        fileSize: Buffer.byteLength(JSON.stringify(parsed.package), 'utf8'),
        fileHash: parsed.packageHash,
        mappingHash: sha256(PROSPECT_STAGING_PACKAGE_SCHEMA),
        importIdentityHash: identityHash,
        mapping: {},
        status: 'DRAFT',
        totalRows: parsed.package.sourceWorkbook.rowCount,
        packageSchemaVersion: PROSPECT_STAGING_PACKAGE_SCHEMA,
        packageHash: parsed.packageHash,
        sourceWorkbookHash: parsed.package.sourceWorkbook.sha256,
        packageManifest: json({
          packageId: parsed.package.packageId,
          sourceSystem: parsed.package.sourceSystem,
          createdAt: parsed.package.createdAt,
          sourceWorkbook: parsed.package.sourceWorkbook,
          lineage: parsed.package.lineage,
          counts: parsed.package.counts,
        }),
        createdBy: input.actor.id,
      },
    })
    for (let offset = 0; offset < parsed.package.records.length; offset += 500) {
      const records = parsed.package.records.slice(offset, offset + 500)
      await tx.prospectImportSourceRecord.createMany({
        data: records.map((record) => ({
          importId: prospectImport.id,
          sourceSystem: parsed.package.sourceSystem,
          sourceWorkbookHash: parsed.package.sourceWorkbook.sha256,
          recordKind: record.kind,
          externalRecordId: record.externalId,
          parentExternalId: record.parentExternalId ?? null,
          recordHash: sha256(`${parsed.packageHash}:${record.kind}:${record.externalId}`),
          rawPayload: json(record.raw),
          normalizedPayload: json(record.normalized),
          sourceStatus: record.status,
          recordMetadata: json(
            record.kind === 'DRAFT'
              ? {
                  draftVersion: record.draftVersion,
                  supportingEvidenceIds: record.supportingEvidenceIds,
                  humanReviewStatus: record.humanReviewStatus,
                  sendAuthority: record.sendAuthority,
                }
              : {},
          ),
        })),
      })
    }
    return {
      importId: prospectImport.id,
      packageHash: parsed.packageHash,
      sourceRecordCount: parsed.package.records.length,
      replayed: false,
    }
  })
}
