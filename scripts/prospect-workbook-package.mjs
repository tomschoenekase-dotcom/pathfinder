import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const requireFromWorkers = createRequire(new URL('../apps/workers/package.json', import.meta.url))
const XLSX = requireFromWorkers('xlsx')

export const PACKAGE_SCHEMA = 'torchiko.prospect-staging-package/v1'

const FIELD_ALIASES = {
  organizationName: ['organization', 'organization name', 'company'],
  venueName: ['venue', 'venue name', 'name', 'museum', 'attraction'],
  venueType: ['venue type', 'type', 'category'],
  venueSubtype: ['venue subtype', 'subtype'],
  addressLine1: ['address', 'street address', 'address line 1'],
  city: ['city'],
  region: ['state', 'region', 'state/province'],
  postalCode: ['zip', 'zipcode', 'zip code', 'postal code'],
  country: ['country'],
  website: ['website', 'url', 'domain'],
  contactName: ['contact', 'contact name', 'primary contact'],
  contactTitle: ['contact title', 'title', 'job title'],
  contactEmail: ['contact email', 'email'],
  generalEmail: ['general email'],
  phone: ['phone', 'phone number'],
  sourceUrls: ['source urls', 'sources', 'source url'],
  researchDate: ['research date', 'researched at'],
  notes: ['notes'],
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
}

function text(value) {
  if (value === null || value === undefined) return undefined
  const candidate = String(value).trim()
  return candidate || undefined
}

function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function domain(value) {
  const candidate = text(value)
  if (!candidate) return undefined
  try {
    return new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname
      .toLowerCase()
      .replace(/^www\./u, '')
      .replace(/\.$/u, '')
  } catch {
    return undefined
  }
}

function sourceUrls(value) {
  const candidate = text(value)
  if (!candidate) return []
  return candidate
    .split(/\r?\n|;\s*|,\s*(?=https?:\/\/)/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function verifiedSyntaxEmail(value) {
  const candidate = text(value)?.toLowerCase()
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate) ? candidate : undefined
}

function mappedRow(raw) {
  const byHeader = new Map(Object.entries(raw).map(([key, value]) => [normalizeHeader(key), value]))
  const result = {}
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const value = byHeader.get(alias)
      if (text(value)) {
        result[field] = text(value)
        break
      }
    }
  }
  result.sourceUrls = sourceUrls(result.sourceUrls)
  return result
}

export function stableProspectExternalId(row) {
  const venueName = normalizeName(row.venueName)
  const city = normalizeName(row.city)
  const region = normalizeName(row.region)
  if (!venueName || !city || !region) {
    throw new Error('A stable prospect identity requires venue name, city and state/region')
  }
  // Workbook profiling proved venue+city+region unique. Volatile research fields and shared
  // domains are deliberately excluded so refreshes and multi-location venues replay safely.
  const identity = [venueName, city, region].join('\n')
  return `prospect-${hash(identity).slice(0, 32)}`
}

function contactExternalId(parentId, row) {
  const contactIdentity = [
    String(row.contactEmail ?? '')
      .trim()
      .toLowerCase(),
    normalizeName(row.contactName),
    String(row.phone ?? '').replace(/\D/gu, ''),
  ].join('\n')
  return `contact-${hash(`${parentId}\n${contactIdentity}`).slice(0, 32)}`
}

function jsonSafe(value) {
  // Packages are hashed and admitted from the exact persisted JSON representation.
  // Undefined object values must not create a different hash after a JSON round trip.
  return JSON.parse(JSON.stringify(value))
}

function rawRowHash(raw) {
  return hash(
    JSON.stringify(Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)))),
  )
}

function contactCandidates(row) {
  const named = Boolean(row.contactEmail || row.contactName || row.contactTitle)
  const sameEmail = Boolean(
    row.contactEmail &&
    row.generalEmail &&
    row.contactEmail.toLowerCase() === row.generalEmail.toLowerCase(),
  )
  const separateGeneral = Boolean(row.generalEmail && !sameEmail)
  const candidates = []
  if (named) {
    candidates.push({
      contactName: row.contactName,
      contactTitle: row.contactTitle,
      contactEmail: row.contactEmail,
      phone: separateGeneral ? undefined : row.phone,
      sourceRole: sameEmail ? 'CONTACT_AND_GENERAL_EMAIL_RECORDED' : 'CONTACT_FIELDS_RECORDED',
    })
  }
  if (separateGeneral || (!named && row.phone)) {
    candidates.push({
      contactEmail: row.generalEmail,
      phone: row.phone,
      sourceRole: row.generalEmail ? 'GENERAL_CHANNEL_RECORDED' : 'PHONE_ONLY_RECORDED',
    })
  }
  // A general inbox must never inherit a person's name/title merely because they
  // appeared on the same row. Equal explicitly recorded emails coalesce once.
  return candidates
}

export function buildProspectStagingPackage({
  workbookBuffer,
  workbookName,
  sheets,
  createdAt = new Date().toISOString(),
  runId = 'local-prospect-workbook-import',
}) {
  const workbookHash = hash(workbookBuffer)
  const workbook = XLSX.read(workbookBuffer, {
    type: 'buffer',
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    cellDates: false,
    dense: true,
  })
  const selectedSheets = sheets?.length
    ? sheets
    : workbook.SheetNames.filter((sheet) => normalizeHeader(sheet) !== '00 summary')
  const missingSheets = selectedSheets.filter((sheet) => !workbook.Sheets[sheet])
  if (missingSheets.length)
    throw new Error(`Workbook sheets not found: ${missingSheets.join(', ')}`)

  const prospects = []
  const contacts = []
  const evidence = []
  const identityRows = new Map()
  for (const sheetName of selectedSheets) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: null,
      raw: false,
      blankrows: false,
    })
    rows.forEach((raw, index) => {
      const normalized = mappedRow(raw)
      const originalRowNumber = Number.isInteger(raw.__rowNum__) ? raw.__rowNum__ + 1 : index + 2
      const sourceLocation = { sheetName, originalRowNumber, rawRowSha256: rawRowHash(raw) }
      let externalId
      try {
        externalId = stableProspectExternalId(normalized)
      } catch (error) {
        throw new Error(`${sheetName} row ${originalRowNumber}: ${error.message}`)
      }
      if (identityRows.has(externalId)) {
        const first = identityRows.get(externalId)
        throw new Error(
          `Stable prospect identity collision at ${sheetName} row ${originalRowNumber}; first seen at ${first.sheetName} row ${first.originalRowNumber}`,
        )
      }
      identityRows.set(externalId, sourceLocation)
      const sourceRecord = {
        kind: 'PROSPECT',
        externalId,
        raw: { ...raw, _source: sourceLocation },
        normalized: {
          organizationName: normalized.organizationName || normalized.venueName,
          venueName: normalized.venueName || normalized.organizationName,
          website: normalized.website,
          domain: domain(normalized.website),
          organizationType: normalized.venueType,
          venueType: normalized.venueSubtype || normalized.venueType,
          addressLine1: normalized.addressLine1,
          city: normalized.city,
          region: normalized.region,
          postalCode: normalized.postalCode,
          country: normalized.country,
          territory: sheetName,
          duplicateOutcome: 'KEEP_DISTINCT',
          fitAttributes: {},
        },
        status: 'SOURCE_ONLY_UNVERIFIED',
      }
      prospects.push(sourceRecord)
      evidence.push({
        kind: 'EVIDENCE',
        externalId: `evidence-${externalId.slice('prospect-'.length)}`,
        parentExternalId: externalId,
        raw: { ...raw, _source: sourceLocation },
        normalized: {
          sourceType: 'WORKBOOK',
          label: `${sheetName} row ${originalRowNumber}`,
          url: normalized.sourceUrls[0],
          urls: normalized.sourceUrls,
          researchedAt:
            normalized.researchDate && Number.isFinite(Date.parse(normalized.researchDate))
              ? normalized.researchDate
              : undefined,
        },
        status: 'SOURCE_ONLY_UNVERIFIED',
      })
      for (const candidate of contactCandidates(normalized)) {
        contacts.push({
          kind: 'CONTACT',
          externalId: contactExternalId(externalId, candidate),
          parentExternalId: externalId,
          raw: { ...raw, _source: sourceLocation },
          normalized: {
            fullName: candidate.contactName,
            title: candidate.contactTitle,
            email: verifiedSyntaxEmail(candidate.contactEmail),
            phone: candidate.phone,
            sourceRole: candidate.sourceRole,
          },
          status: 'SOURCE_ONLY_UNVERIFIED',
        })
      }
    })
  }
  if (!prospects.length) throw new Error('No prospect rows were found in the selected sheets')
  const records = [...prospects, ...contacts, ...evidence]
  return jsonSafe({
    schema: PACKAGE_SCHEMA,
    packageId: `pathfinder-tier1-${workbookHash.slice(0, 24)}`,
    sourceSystem: 'HERMES_STAGING',
    createdAt,
    sourceWorkbook: {
      name: path.basename(workbookName),
      sha256: workbookHash,
      rowCount: prospects.length,
    },
    lineage: { runId, promptVersion: 'local-workbook-source-only-v2', models: [] },
    counts: {
      PROSPECT: prospects.length,
      CONTACT: contacts.length,
      EVIDENCE: evidence.length,
      DRAFT: 0,
      DUPLICATE_REVIEW: 0,
      EXCEPTION: 0,
      RUN_LOG: 0,
    },
    records,
  })
}
