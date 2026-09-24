import { z } from 'zod'

export const researchDirectoryFields = {
  contactState: z.enum(['RECORDED', 'MISSING', 'REVIEW_NEEDED', 'SUPPRESSED']).optional(),
  provenance: z.enum(['IMPORTED', 'SOURCE_URL_RECORDED', 'WEB_EVIDENCE', 'NO_EVIDENCE']).optional(),
  completeness: z.enum(['CORE_PRESENT', 'NEEDS_RESEARCH']).optional(),
  websiteState: z.enum(['RECORDED', 'MISSING']).optional(),
  sort: z.enum(['UPDATED', 'NAME_ASC', 'NAME_DESC']).default('UPDATED'),
}

export type ResearchDirectoryFilters = z.infer<z.ZodObject<typeof researchDirectoryFields>>

/** Presence is research coverage, never consent or outreach readiness. */
export function researchDirectoryWhere(input: ResearchDirectoryFilters) {
  const contact = { archivedAt: null }
  const email = { archivedAt: null, normalizedEmail: { not: null } }
  const core = {
    website: { not: null },
    organizationType: { not: null },
    territoryId: { not: null },
    venues: { some: { archivedAt: null, city: { not: null }, region: { not: null } } },
    contacts: { some: email },
    sources: { some: {} },
  }
  return [
    ...(input.contactState === 'RECORDED' ? [{ contacts: { some: contact } }] : []),
    ...(input.contactState === 'MISSING' ? [{ contacts: { none: contact } }] : []),
    ...(input.contactState === 'REVIEW_NEEDED'
      ? [
          {
            contacts: {
              some: {
                ...contact,
                OR: [
                  { emailReadiness: 'UNKNOWN' as const },
                  { permissionState: 'UNKNOWN' as const },
                ],
              },
            },
          },
        ]
      : []),
    ...(input.contactState === 'SUPPRESSED'
      ? [
          {
            contacts: {
              some: {
                archivedAt: null,
                OR: [
                  { doNotContact: true },
                  { suppressedAt: { not: null } },
                  { unsubscribedAt: { not: null } },
                  { permissionState: { in: ['OPTED_OUT' as const, 'PROHIBITED' as const] } },
                ],
              },
            },
          },
        ]
      : []),
    ...(input.websiteState === 'RECORDED' ? [{ website: { not: null } }] : []),
    ...(input.websiteState === 'MISSING' ? [{ website: null }] : []),
    ...(input.provenance === 'IMPORTED'
      ? [
          {
            sources: {
              some: {
                OR: [
                  { importRowId: { not: null } },
                  { sourceType: { in: ['WORKBOOK', 'IMPORT', 'STAGING_PACKAGE'] } },
                ],
              },
            },
          },
        ]
      : []),
    ...(input.provenance === 'SOURCE_URL_RECORDED'
      ? [{ sources: { some: { sourceUrl: { not: null } } } }]
      : []),
    ...(input.provenance === 'WEB_EVIDENCE'
      ? [
          {
            sources: {
              some: {
                sourceUrl: { not: null },
                sourceType: { notIn: ['WORKBOOK', 'IMPORT', 'STAGING_PACKAGE'] },
              },
            },
          },
        ]
      : []),
    ...(input.provenance === 'NO_EVIDENCE' ? [{ sources: { none: {} } }] : []),
    ...(input.completeness === 'CORE_PRESENT' ? [core] : []),
    ...(input.completeness === 'NEEDS_RESEARCH' ? [{ NOT: core }] : []),
  ]
}

const nameCursor = z
  .object({
    name: z.string().max(2000),
    id: z.string().min(1).max(191),
    sort: z.enum(['NAME_ASC', 'NAME_DESC']),
  })
  .strict()

export function encodeResearchNameCursor(
  row: { canonicalName: string; id: string },
  sort: 'NAME_ASC' | 'NAME_DESC',
) {
  return Buffer.from(JSON.stringify({ name: row.canonicalName, id: row.id, sort })).toString(
    'base64url',
  )
}

export function researchNameCursorWhere(encoded: string, sort: 'NAME_ASC' | 'NAME_DESC') {
  const cursor = nameCursor.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
  if (cursor.sort !== sort) throw new Error('Cursor sort mismatch')
  const comparison = sort === 'NAME_ASC' ? 'gt' : 'lt'
  return {
    OR: [
      { canonicalName: { [comparison]: cursor.name } },
      { canonicalName: cursor.name, id: { [comparison]: cursor.id } },
    ],
  }
}
