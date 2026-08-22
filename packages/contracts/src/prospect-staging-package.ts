import { createHash } from 'node:crypto'

import { z } from 'zod'

export const PROSPECT_STAGING_PACKAGE_SCHEMA = 'torchiko.prospect-staging-package/v1' as const
export const PROSPECT_STAGING_PACKAGE_MAX_RECORDS = 100_000

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const externalId = z.string().trim().min(1).max(191)
const jsonObject = z.record(z.unknown())

export const ProspectStagingRecordKind = z.enum([
  'PROSPECT',
  'CONTACT',
  'EVIDENCE',
  'DRAFT',
  'DUPLICATE_REVIEW',
  'EXCEPTION',
  'RUN_LOG',
])

const baseRecord = z.object({
  kind: ProspectStagingRecordKind,
  externalId,
  parentExternalId: externalId.optional(),
  raw: jsonObject,
  normalized: jsonObject.default({}),
  status: z.string().trim().min(1).max(100),
})

const ordinaryRecord = baseRecord.extend({
  kind: z.enum(['PROSPECT', 'CONTACT', 'EVIDENCE', 'DUPLICATE_REVIEW', 'EXCEPTION', 'RUN_LOG']),
})

const draftRecord = baseRecord.extend({
  kind: z.literal('DRAFT'),
  draftVersion: z.number().int().min(1).max(10_000),
  supportingEvidenceIds: z.array(externalId).max(100).default([]),
  humanReviewStatus: z.literal('NOT_REVIEWED'),
  sendAuthority: z.literal('NONE'),
})

export const ProspectStagingPackageV1 = z
  .object({
    schema: z.literal(PROSPECT_STAGING_PACKAGE_SCHEMA),
    packageId: externalId,
    sourceSystem: z.literal('HERMES_STAGING'),
    createdAt: z.string().datetime({ offset: true }),
    sourceWorkbook: z
      .object({
        name: z.string().trim().min(1).max(500),
        sha256,
        rowCount: z.number().int().min(1).max(PROSPECT_STAGING_PACKAGE_MAX_RECORDS),
      })
      .strict(),
    lineage: z
      .object({
        runId: externalId,
        promptVersion: z.string().trim().min(1).max(191),
        models: z.array(z.string().trim().min(1).max(191)).max(50).default([]),
      })
      .strict(),
    counts: z.record(ProspectStagingRecordKind, z.number().int().min(0)),
    records: z
      .array(z.discriminatedUnion('kind', [ordinaryRecord, draftRecord]))
      .max(PROSPECT_STAGING_PACKAGE_MAX_RECORDS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const identities = new Set<string>()
    const externalIdentities = new Map(
      value.records.map((record) => [record.externalId, record.kind]),
    )
    const seenExternalIdentities = new Set<string>()
    const draftVersions = new Set<string>()
    const evidenceIds = new Set(
      value.records
        .filter((record) => record.kind === 'EVIDENCE')
        .map((record) => record.externalId),
    )
    const observed = Object.fromEntries(ProspectStagingRecordKind.options.map((kind) => [kind, 0]))
    for (const [index, record] of value.records.entries()) {
      const identity = `${record.kind}:${record.externalId}`
      if (identities.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'externalId'],
          message: `Duplicate staging identity: ${identity}`,
        })
      }
      identities.add(identity)
      if (seenExternalIdentities.has(record.externalId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'externalId'],
          message: `External record IDs must be package-global: ${record.externalId}`,
        })
      }
      seenExternalIdentities.add(record.externalId)
      observed[record.kind] = (observed[record.kind] ?? 0) + 1
      if (record.parentExternalId && !externalIdentities.has(record.parentExternalId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'parentExternalId'],
          message: `Parent record is missing: ${record.parentExternalId}`,
        })
      }
      if (
        record.kind === 'CONTACT' &&
        externalIdentities.get(record.parentExternalId ?? '') !== 'PROSPECT'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['records', index, 'parentExternalId'],
          message: 'Contact parent must be a prospect record',
        })
      }
      if (record.kind === 'DRAFT') {
        const draftIdentity = `${record.parentExternalId ?? ''}:${record.draftVersion}`
        if (!record.parentExternalId || draftVersions.has(draftIdentity)) {
          ctx.addIssue({
            code: 'custom',
            path: ['records', index, 'draftVersion'],
            message: 'Draft requires a parent and a unique parent/version pair',
          })
        }
        draftVersions.add(draftIdentity)
        for (const evidenceId of record.supportingEvidenceIds) {
          if (!evidenceIds.has(evidenceId)) {
            ctx.addIssue({
              code: 'custom',
              path: ['records', index, 'supportingEvidenceIds'],
              message: `Draft references missing evidence: ${evidenceId}`,
            })
          }
        }
      }
    }
    for (const kind of ProspectStagingRecordKind.options) {
      if ((value.counts[kind] ?? 0) !== observed[kind]) {
        ctx.addIssue({
          code: 'custom',
          path: ['counts', kind],
          message: `Declared ${kind} count does not match records`,
        })
      }
    }
    if ((value.counts.PROSPECT ?? 0) !== value.sourceWorkbook.rowCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceWorkbook', 'rowCount'],
        message: 'Source workbook row count must equal the admitted prospect record count',
      })
    }
  })

export type ProspectStagingPackageV1Type = z.infer<typeof ProspectStagingPackageV1>

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

export function prospectStagingPackageHash(value: ProspectStagingPackageV1Type): string {
  return createHash('sha256')
    .update(`torchiko-prospect-staging-package-v1\n${canonical(value)}`, 'utf8')
    .digest('hex')
}

export function parseProspectStagingPackage(value: unknown) {
  const parsed = ProspectStagingPackageV1.parse(value)
  return { package: parsed, packageHash: prospectStagingPackageHash(parsed) }
}
