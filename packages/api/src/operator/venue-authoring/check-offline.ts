import { venuePackageGuideQualityWarnings } from '../../lib/venue-guide-quality'
import { VenuePackagePayload } from '../../schemas/venue-package'
import { venuePackageAuthoringFindings } from './authoring-checks'
import { explainVenuePackageIssues } from './package-issues'

/**
 * The package checks that need no database: the same schema, writing-guide and authoring rules as
 * venues.check_package, for a package that has no venue binding yet. It cannot see the venue's
 * existing records, settings or embeddings, so it never claims more than "valid offline".
 */
export type OfflineFinding = { code: string; path: string; message: string; fix?: string }

export type OfflinePackageCheck = {
  /** Schema passes, no writing-guide finding and no exact in-package duplicate. */
  readyOffline: boolean
  errors: OfflineFinding[]
  guideQuality: OfflineFinding[]
  duplicates: OfflineFinding[]
  authoring: OfflineFinding[]
  sources: {
    hosts: Record<string, number>
    withoutUrl: number
    offOfficialDomain: OfflineFinding[]
  }
  records: { places: number; knowledge: number }
  notChecked: string[]
}

const NOT_CHECKED = [
  'existing venue records (DUPLICATE_EXISTING_CONTENT, update/delete ids)',
  'semantic duplicate scan and embedding readiness',
  'venue settings (time zone, guide mode)',
  'whether the facts are true: compare with your source ledger',
  'visitor answers and the rendered guest page (gates 4 and 5)',
]

const normalizeLabel = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()

type Operation = {
  provenance?: { sourceUrl?: string | null }
  value?: Record<string, unknown>
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '')
  } catch {
    return null
  }
}

export function checkVenuePackageOffline(
  json: unknown,
  options: { now: Date; officialDomain?: string | undefined },
): OfflinePackageCheck {
  const parsed = VenuePackagePayload.safeParse(json)
  if (!parsed.success) {
    return {
      readyOffline: false,
      errors: explainVenuePackageIssues(parsed.error.issues, json),
      guideQuality: [],
      duplicates: [],
      authoring: [],
      sources: { hosts: {}, withoutUrl: 0, offOfficialDomain: [] },
      records: { places: 0, knowledge: 0 },
      notChecked: ['everything after the schema: fix errors first', ...NOT_CHECKED],
    }
  }
  const payload = parsed.data
  const guideQuality = venuePackageGuideQualityWarnings(payload, {
    today: options.now.toISOString().slice(0, 10),
  })
  const authoring = venuePackageAuthoringFindings(payload, options.now)

  const named: Array<{ kind: 'place' | 'knowledge'; label: string; path: string; op: Operation }> =
    payload.schemaVersion === 3
      ? [
          ...payload.places.create.map((op, i) => ({
            kind: 'place' as const,
            label: op.value.name,
            path: `places.create.${i}`,
            op,
          })),
          ...payload.places.update.map((op, i) => ({
            kind: 'place' as const,
            label: op.value.name,
            path: `places.update.${i}`,
            op,
          })),
          ...payload.knowledgeEntries.create.map((op, i) => ({
            kind: 'knowledge' as const,
            label: op.value.title,
            path: `knowledgeEntries.create.${i}`,
            op,
          })),
          ...payload.knowledgeEntries.update.map((op, i) => ({
            kind: 'knowledge' as const,
            label: op.value.title,
            path: `knowledgeEntries.update.${i}`,
            op,
          })),
        ]
      : [
          ...payload.places.map((place, i) => ({
            kind: 'place' as const,
            label: place.name,
            path: `places.${i}`,
            op: {},
          })),
          ...payload.knowledgeEntries.map((entry, i) => ({
            kind: 'knowledge' as const,
            label: entry.title,
            path: `knowledgeEntries.${i}`,
            op: {},
          })),
        ]

  const duplicates: OfflineFinding[] = []
  const seen = new Set<string>()
  for (const record of named) {
    const key = `${record.kind}:${normalizeLabel(record.label)}`
    if (seen.has(key)) {
      duplicates.push({
        code: 'DUPLICATE_IN_PACKAGE',
        path: `${record.path}.value.${record.kind === 'place' ? 'name' : 'title'}`,
        message: `Another package ${record.kind === 'place' ? 'place' : 'knowledge entry'} is named “${record.label}”. Merge them or give each its own clear name.`,
      })
    }
    seen.add(key)
  }

  const hosts: Record<string, number> = {}
  let withoutUrl = 0
  const offOfficialDomain: OfflineFinding[] = []
  const official = options.officialDomain?.toLowerCase().replace(/^www\./u, '')
  for (const record of named) {
    const url = record.op.provenance?.sourceUrl
    const host = url ? hostOf(url) : null
    if (!host) {
      withoutUrl += 1
      continue
    }
    hosts[host] = (hosts[host] ?? 0) + 1
    if (official && host !== official && !host.endsWith(`.${official}`)) {
      offOfficialDomain.push({
        code: 'SOURCE_OFF_OFFICIAL_DOMAIN',
        path: `${record.path}.provenance.sourceUrl`,
        message: `“${record.label}” cites ${host}, not ${official}.`,
        fix: 'Confirm in your ledger that this source is about this exact venue (same city and operator), or replace it with the official page.',
      })
    }
  }

  return {
    readyOffline: guideQuality.length === 0 && duplicates.length === 0,
    errors: [],
    guideQuality,
    duplicates,
    authoring,
    sources: { hosts, withoutUrl, offOfficialDomain },
    records: {
      places: named.filter((record) => record.kind === 'place').length,
      knowledge: named.filter((record) => record.kind === 'knowledge').length,
    },
    notChecked: NOT_CHECKED,
  }
}
