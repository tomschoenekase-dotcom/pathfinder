import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { isPublicWebsiteAddress, isPrivateHostname } from '../../lib/website-intake'
import {
  resolveProspectImportRowAction,
  stageProspectImportRowsAction,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { sourceCellDigests } from './crm-import-retention'
import { computeImportPlan } from '../crm-import-plan'
import type { OperatorCallContext, OperatorReadTool } from '../registry'

const MAX_CSV_BYTES = 100_000
const MAX_ROWS = 500
const MAX_COLUMNS = 50
const MAX_CELL_CHARS = 65_536
const SHEET = 'MCP CSV'

export const CSV_IMPORT_FIELDS = new Set([
  'venueName',
  'gmailMessageId',
  'gmailThreadId',
  'gmailDraftId',
  'mailboxAddress',
  'claimedSentAt',
  'claimedDeliveryState',
  'claimedDraftState',
  'claimedRelationshipState',

  'existingOrganizationId',
  'existingVenueId',
  'addressLine1',
  'postalCode',
  'organizationName',
  'venueType',
  'venueSubtype',
  'city',
  'region',
  'country',
  'website',
  'generalEmail',
  'contactName',
  'contactTitle',
  'contactEmail',
  'phone',
  'shortDescription',
  'sourceUrls',
  'notes',
  'territory',
])
const ALIASES: Record<string, string> = {
  address: 'addressLine1',
  streetaddress: 'addressLine1',
  addressline1: 'addressLine1',
  zip: 'postalCode',
  zipcode: 'postalCode',
  postalcode: 'postalCode',
  organizationid: 'existingOrganizationId',
  existingorganizationid: 'existingOrganizationId',
  venueid: 'existingVenueId',
  existingvenueid: 'existingVenueId',
  accountid: 'existingOrganizationId',
  research: 'notes',
  provenance: 'notes',
  researchprovenance: 'notes',
  gmailmessageid: 'gmailMessageId',
  gmailthreadid: 'gmailThreadId',
  gmaildraftid: 'gmailDraftId',
  mailboxaddress: 'mailboxAddress',
  claimedsentat: 'claimedSentAt',
  claimeddeliverystate: 'claimedDeliveryState',
  claimeddraftstate: 'claimedDraftState',
  claimedrelationshipstate: 'claimedRelationshipState',
  venue: 'venueName',
  venuename: 'venueName',
  name: 'venueName',
  organization: 'organizationName',
  organizationname: 'organizationName',
  account: 'organizationName',
  city: 'city',
  state: 'region',
  region: 'region',
  country: 'country',
  website: 'website',
  url: 'website',
  type: 'venueType',
  venuetype: 'venueType',
  email: 'generalEmail',
  generalemail: 'generalEmail',
  contact: 'contactName',
  contactname: 'contactName',
  contactemail: 'contactEmail',
  phone: 'phone',
  notes: 'notes',
  sourceurls: 'sourceUrls',
}

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

function commitOperationId(importId: string) {
  const digest = sha256(`mcp-csv-commit:v1:${importId}`)
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

export class CsvImportError extends Error {
  constructor(
    readonly code: 'INVALID_CSV' | 'FETCH_FAILED' | 'SCOPE_REQUIRED' | 'OPERATION_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'CsvImportError'
  }
}

/**
 * RFC 4180 quoting and embedded newlines, with no formula evaluation or automatic coercion.
 * Blank records (an empty line or only empty cells, as spreadsheet exports often append) are
 * dropped; `rowNumbers` keeps each remaining row's 1-based record number, header included.
 */
export function parseBoundedCsv(csv: string): {
  headers: string[]
  rows: string[][]
  rowNumbers: number[]
} {
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES)
    throw new CsvImportError('INVALID_CSV', 'CSV exceeds the byte limit')
  const records: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let afterQuote = false
  const source = csv.replace(/^\uFEFF/u, '')
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"'
        i++
      } else if (char === '"') {
        quoted = false
        afterQuote = true
      } else cell += char
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell)
      cell = ''
      afterQuote = false
      if (char !== ',') {
        if (char === '\r' && source[i + 1] === '\n') i++
        records.push(row)
        row = []
        if (records.length > MAX_ROWS + 1)
          throw new CsvImportError('INVALID_CSV', 'CSV exceeds the row limit')
      }
    } else if (char === '"' && cell === '' && !afterQuote) quoted = true
    else if (afterQuote || char === '"')
      throw new CsvImportError('INVALID_CSV', 'CSV quoting is malformed')
    else cell += char
    if (cell.length > MAX_CELL_CHARS)
      throw new CsvImportError('INVALID_CSV', 'CSV cell exceeds the character limit')
  }
  if (quoted) throw new CsvImportError('INVALID_CSV', 'CSV quoting is malformed')
  if (cell || row.length || afterQuote) {
    row.push(cell)
    records.push(row)
  }
  if (records.length > MAX_ROWS + 1)
    throw new CsvImportError('INVALID_CSV', 'CSV exceeds the row limit')
  const headers = records.shift()?.map((value) => value.trim()) ?? []
  if (
    !headers.length ||
    headers.length > MAX_COLUMNS ||
    headers.some((value) => !value || value.length > 300)
  ) {
    throw new CsvImportError('INVALID_CSV', 'CSV header is missing or too wide')
  }
  if (new Set(headers.map((value) => value.toLowerCase())).size !== headers.length) {
    throw new CsvImportError('INVALID_CSV', 'CSV headers must be distinct')
  }
  const rows: string[][] = []
  const rowNumbers: number[] = []
  records.forEach((entry, index) => {
    if (entry.every((value) => value.trim() === '')) return
    if (entry.length !== headers.length)
      throw new CsvImportError('INVALID_CSV', 'CSV row width differs from header')
    rows.push(entry)
    rowNumbers.push(index + 2)
  })
  if (!rows.length) throw new CsvImportError('INVALID_CSV', 'CSV has no data rows')
  return { headers, rows, rowNumbers }
}

/** Location comparison key: case, accents, punctuation and whitespace runs never split a place. */
function locationKey(value: string | undefined): string | null {
  const key = (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return key || null
}

function mappingFor(headers: string[], supplied?: Record<string, string>) {
  const mapping: Record<string, string> = {}
  for (const header of headers) {
    const key = header.toLowerCase().replace(/[^a-z0-9]/gu, '')
    const field = ALIASES[key]
    if (field && !mapping[field]) mapping[field] = header
  }
  for (const [field, header] of Object.entries(supplied ?? {})) {
    if (!CSV_IMPORT_FIELDS.has(field) || !headers.includes(header))
      throw new CsvImportError('INVALID_CSV', 'Mapping names an unknown field or column')
    mapping[field] = header
  }
  if (!mapping.venueName) throw new CsvImportError('INVALID_CSV', 'Map a venue name column')
  return mapping
}

type File = {
  download_url: string
  file_id: string
  mime_type?: string | undefined
  file_name?: string | undefined
}
export type CsvDownload = (file: File) => Promise<string>

/** What one kind of attachment allows, and how its errors are worded. */
export type AttachmentPolicy = Readonly<{
  maxBytes: number
  mimeTypes: readonly string[]
  accept: string
  /** Completes "Attachment must be ..." and "Attachment is not UTF-8 ...". */
  typeLabel: string
  textLabel: string
  /** `INVALID` is the file's own fault (wrong type or encoding); `FETCH_FAILED` is retryable. */
  error: (code: 'INVALID' | 'FETCH_FAILED', message: string) => Error
}>

const CSV_ATTACHMENT: AttachmentPolicy = {
  maxBytes: MAX_CSV_BYTES,
  mimeTypes: ['text/csv', 'application/csv', 'text/plain', 'application/octet-stream'],
  accept: 'text/csv,text/plain',
  typeLabel: 'a CSV',
  textLabel: 'CSV',
  error: (code, message) =>
    new CsvImportError(code === 'INVALID' ? 'INVALID_CSV' : 'FETCH_FAILED', message),
}

/** Fetch a signed CSV attachment by pinned public DNS address. Every redirect is checked anew. */
export const downloadCsvAttachment: CsvDownload = (file) => downloadAttachment(file, CSV_ATTACHMENT)

/** Fetch a signed attachment by pinned public DNS address. Every redirect is checked anew. */
export async function downloadAttachment(file: File, policy: AttachmentPolicy): Promise<string> {
  const fail = policy.error
  if (file.mime_type && !policy.mimeTypes.includes(file.mime_type.toLowerCase())) {
    throw fail('INVALID', `Attachment must be ${policy.typeLabel}`)
  }
  let current = file.download_url
  const deadline = Date.now() + 15_000
  for (let redirect = 0; redirect <= 2; redirect++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw fail('FETCH_FAILED', 'Attachment timed out')
    let url: URL
    try {
      url = new URL(current)
    } catch {
      throw fail('FETCH_FAILED', 'Attachment URL is invalid')
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      isPrivateHostname(url.hostname) ||
      isIP(url.hostname) !== 0
    ) {
      throw fail('FETCH_FAILED', 'Attachment URL is not a public HTTPS address')
    }
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true })
        .then((rows) => rows.map((row) => row.address))
        .catch(() => []),
      new Promise<string[]>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(fail('FETCH_FAILED', 'Attachment DNS timed out')),
          remaining,
        )
      }),
    ]).finally(() => clearTimeout(dnsTimer))
    if (
      !addresses.length ||
      addresses.length > 16 ||
      addresses.some((address) => !isPublicWebsiteAddress(address))
    ) {
      throw fail('FETCH_FAILED', 'Attachment host is not public')
    }
    const requestRemaining = deadline - Date.now()
    if (requestRemaining <= 0) throw fail('FETCH_FAILED', 'Attachment timed out')
    const response = await new Promise<{ status: number; location?: string; body: Buffer }>(
      (resolve, reject) => {
        const req = httpsRequest(
          {
            hostname: addresses[0],
            port: 443,
            servername: url.hostname,
            method: 'GET',
            path: `${url.pathname}${url.search}`,
            headers: {
              Host: url.host,
              Accept: policy.accept,
              'Accept-Encoding': 'identity',
            },
            timeout: Math.min(10_000, requestRemaining),
          },
          (incoming) => {
            const declared = Number(incoming.headers['content-length'] ?? 0)
            if (declared > policy.maxBytes) {
              incoming.destroy()
              reject(fail('FETCH_FAILED', 'Attachment exceeds the byte limit'))
              return
            }
            const chunks: Buffer[] = []
            let size = 0
            incoming.on('data', (part: Buffer) => {
              size += part.byteLength
              if (size > policy.maxBytes)
                incoming.destroy(fail('FETCH_FAILED', 'Attachment exceeds the byte limit'))
              else chunks.push(part)
            })
            incoming.on('error', reject)
            incoming.on('end', () =>
              resolve({
                status: incoming.statusCode ?? 0,
                ...(incoming.headers.location ? { location: incoming.headers.location } : {}),
                body: Buffer.concat(chunks),
              }),
            )
          },
        )
        req.on('timeout', () => req.destroy(fail('FETCH_FAILED', 'Attachment timed out')))
        const absoluteDeadline = setTimeout(
          () => req.destroy(fail('FETCH_FAILED', 'Attachment timed out')),
          requestRemaining,
        )
        req.on('close', () => clearTimeout(absoluteDeadline))
        req.on('error', reject)
        req.end()
      },
    ).catch(() => {
      throw fail('FETCH_FAILED', 'Attachment could not be downloaded')
    })
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      try {
        current = new URL(response.location, url).toString()
      } catch {
        throw fail('FETCH_FAILED', 'Attachment redirect URL is invalid')
      }
      continue
    }
    if (response.status !== 200) throw fail('FETCH_FAILED', 'Attachment download failed')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(response.body)
    } catch {
      throw fail('INVALID', `Attachment is not UTF-8 ${policy.textLabel}`)
    }
  }
  throw fail('FETCH_FAILED', 'Attachment redirected too many times')
}

function normalizedValues(source: Record<string, string>, mapping: Record<string, string>) {
  const result: Record<string, string | string[]> = { venueName: '' }
  for (const [field, header] of Object.entries(mapping)) {
    const value = source[header]?.trim()
    if (!value) continue
    result[field] =
      field === 'sourceUrls'
        ? value
            .split('|')
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 20)
        : value
  }
  return result as { venueName: string }
}

export async function stageCsvImport(
  raw: unknown,
  context: OperatorCallContext,
  download: CsvDownload = downloadCsvAttachment,
) {
  const input = OPERATOR_MCP_INPUTS['crm.stage_csv_import'].parse(raw)
  if (!context.grant.allTenants || !context.config.allowedUserIds.has(context.grant.userId)) {
    throw new CsvImportError('SCOPE_REQUIRED', 'A platform-wide CRM grant is required')
  }
  const importIdentityHash = sha256(`mcp-csv:v1:${context.grant.grantId}:${input.operationId}`)
  const database = context.database
  const legacySuppliedMappingHash = sha256(JSON.stringify(input.mapping ?? null))
  const suppliedMappingHash = sha256(
    JSON.stringify(
      input.mapping
        ? Object.fromEntries(
            Object.entries(input.mapping).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : null,
    ),
  )
  // Historical manifests hash JSON insertion order. Preserve those receipts without rewriting
  // their identity; new manifests use sorted keys so equivalent mapping order is immaterial.
  const matchesSuppliedMapping = (hash: string | undefined) =>
    hash === suppliedMappingHash || hash === legacySuppliedMappingHash
  const suppliedFileIdHash = input.file ? sha256(input.file.file_id) : null
  const existing = await database.prospectImport.findUnique({ where: { importIdentityHash } })
  if (existing) {
    const manifest = existing.packageManifest as {
      suppliedMappingHash?: string
      suppliedFileIdHash?: string | null
    } | null
    if (
      !matchesSuppliedMapping(manifest?.suppliedMappingHash) ||
      (input.file && manifest?.suppliedFileIdHash !== suppliedFileIdHash) ||
      (input.csvText && existing.fileHash !== sha256(input.csvText))
    ) {
      throw new CsvImportError(
        'OPERATION_CONFLICT',
        'Operation ID was used with different CSV content or mapping',
      )
    }
    if (
      (manifest as { stagingComplete?: boolean } | null)?.stagingComplete ||
      ['APPROVED', 'PROCESSING', 'PARTIAL', 'COMPLETE', 'CANCELLED'].includes(existing.status)
    ) {
      return receipt(database, existing.id, true)
    }
  }
  const csv = input.csvText ?? (await download(input.file!))
  const parsed = parseBoundedCsv(csv)
  const mapping = mappingFor(parsed.headers, input.mapping)
  const retentionDigests = parsed.rows.map((cells, index) => ({
    row: parsed.rowNumbers[index]!,
    fields: sourceCellDigests(
      Object.fromEntries(parsed.headers.map((header, column) => [header, cells[column] ?? ''])),
    ),
  }))
  const fileHash = sha256(csv)
  const mappingHash = sha256(
    JSON.stringify(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b))),
  )
  const actor = {
    type: 'HUMAN' as const,
    id: context.grant.userId,
    role: 'PLATFORM_ADMIN' as const,
  }
  if (existing && (existing.fileHash !== fileHash || existing.mappingHash !== mappingHash)) {
    throw new CsvImportError(
      'OPERATION_CONFLICT',
      'Operation ID was used with different CSV content or mapping',
    )
  }
  let prospectImport = existing
  if (!prospectImport) {
    try {
      prospectImport = await database.$transaction(async (rawTx) => {
        const tx = rawTx as typeof database
        const created = await tx.prospectImport.create({
          data: {
            fileName: 'mcp-import.csv',
            fileType: 'csv',
            fileSize: Buffer.byteLength(csv, 'utf8'),
            fileHash,
            mappingHash,
            importIdentityHash,
            mapping,
            packageManifest: {
              mcpCsv: true,
              suppliedMappingHash,
              suppliedFileIdHash,
              sourceRows: parsed.rows.length,
              retentionDigests,
              stagingComplete: false,
            },
            createdBy: actor.id,
            sheets: {
              create: [
                {
                  sheetName: SHEET,
                  sheetIndex: 0,
                  detectedRows: parsed.rows.length,
                  columns: parsed.headers,
                },
              ],
            },
          },
        })
        await writeAuditLogStrict(
          {
            actorType: 'AGENT',
            actorId: `operator-grant:${context.grant.grantId}`,
            actorRole: 'DELEGATED_OPERATOR',
            action: 'operator.crm_csv_import.staged',
            targetType: 'ProspectImport',
            targetId: created.id,
            idempotencyKey: input.operationId,
            afterState: {
              fileHash,
              mappingHash,
              rows: parsed.rows.length,
              grantId: context.grant.grantId,
              clientId: context.grant.clientId,
              requestId: context.requestId,
              ownerUserId: actor.id,
            },
          },
          tx,
        )
        return created
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      prospectImport = await database.prospectImport.findUnique({ where: { importIdentityHash } })
      const racedManifest = prospectImport?.packageManifest as {
        suppliedFileIdHash?: string | null
        suppliedMappingHash?: string
      } | null
      if (
        !prospectImport ||
        prospectImport.fileHash !== fileHash ||
        prospectImport.mappingHash !== mappingHash ||
        racedManifest?.suppliedFileIdHash !== suppliedFileIdHash ||
        !matchesSuppliedMapping(racedManifest?.suppliedMappingHash)
      ) {
        throw new CsvImportError(
          'OPERATION_CONFLICT',
          'Operation ID was used with different CSV content or mapping',
        )
      }
    }
  }

  // A replay after completion reads the receipt; it never reopens a committed import.
  if (!(prospectImport.packageManifest as { stagingComplete?: boolean } | null)?.stagingComplete)
    try {
      for (let offset = 0; offset < parsed.rows.length; offset += 10) {
        const batch = parsed.rows.slice(offset, offset + 10).map((cells, index) => {
          const sourceValues = Object.fromEntries(
            parsed.headers.map((header, column) => [header, cells[column] ?? '']),
          )
          return {
            sheetName: SHEET,
            originalRowNumber: parsed.rowNumbers[offset + index]!,
            sourceValues,
            normalizedValues: normalizedValues(sourceValues, mapping),
          }
        })
        await stageProspectImportRowsAction(
          { importId: prospectImport.id, rows: batch, actor },
          database,
        )
      }
      const rows = await database.prospectImportRow.findMany({
        where: { importId: prospectImport.id },
        orderBy: { originalRowNumber: 'asc' },
        select: {
          id: true,
          status: true,
          normalizedValues: true,
          sourceValues: true,
          duplicateMatches: true,
          originalRowNumber: true,
        },
      })
      for (const row of rows) {
        const expected = retentionDigests.find((entry) => entry.row === row.originalRowNumber)
        if (
          !expected ||
          JSON.stringify(
            sourceCellDigests(row.sourceValues as Record<string, unknown>).sort((a, b) =>
              a.column.localeCompare(b.column),
            ),
          ) !==
            JSON.stringify([...expected.fields].sort((a, b) => a.column.localeCompare(b.column)))
        ) {
          throw new Error('CSV source field retention mismatch')
        }
      }
      const seen = new Map<string, string>()
      for (const row of rows) {
        const value = row.normalizedValues as {
          normalizedOrganizationName?: string
          normalizedVenueName?: string
          city?: string
          region?: string
          country?: string
          addressLine1?: string
          postalCode?: string
          existingOrganizationId?: string
          existingVenueId?: string
          normalizedDomain?: string | null
        }
        const identity = JSON.stringify([
          value.normalizedOrganizationName,
          value.normalizedVenueName,
          locationKey(value.city),
          locationKey(value.region),
          locationKey(value.country),
          locationKey(value.addressLine1),
          locationKey(value.postalCode),
          value.existingOrganizationId?.trim() || null,
          value.existingVenueId?.trim() || null,
        ])
        // Location parts compare by key, so a case or spacing variant of one address is an
        // exact repeat rather than a second venue or an open review.
        const canonical = JSON.stringify(
          Object.entries({
            ...value,
            city: locationKey(value.city),
            region: locationKey(value.region),
            country: locationKey(value.country),
            addressLine1: locationKey(value.addressLine1),
            postalCode: locationKey(value.postalCode),
          }).sort(([a], [b]) => a.localeCompare(b)),
        )
        const earlier = seen.get(identity)
        const exactWithinFile = earlier === canonical
        const uncertainWithinFile = earlier !== undefined && !exactWithinFile
        if (earlier === undefined) seen.set(identity, canonical)
        const matches = Array.isArray(row.duplicateMatches)
          ? (row.duplicateMatches as Array<{ reasons?: string[] }>)
          : []
        const exactExisting =
          row.status === 'DUPLICATE_REVIEW' &&
          matches.length === 1 &&
          Boolean(value.city) &&
          !value.region &&
          !value.country &&
          !value.addressLine1 &&
          !value.postalCode &&
          matches[0]?.reasons?.includes('normalized-organization-name') &&
          matches[0]?.reasons?.includes('normalized-venue-name') &&
          (!value.normalizedDomain || matches[0]?.reasons?.includes('exact-domain'))
        if (exactExisting) {
          await resolveProspectImportRowAction(
            {
              importId: prospectImport.id,
              rowId: row.id,
              decision: 'SKIP',
              note: 'Exact organization and venue duplicate in the CRM',
              actor,
            },
            database,
          )
        } else if (
          exactWithinFile &&
          ['VALID', 'WARNING', 'DUPLICATE_REVIEW'].includes(row.status)
        ) {
          await database.prospectImportRow.updateMany({
            where: { id: row.id, importId: prospectImport.id, status: row.status },
            data: {
              status: 'SKIPPED',
              decision: 'SKIP',
              decisionNote: 'Exact duplicate earlier in this CSV',
              decisionBy: actor.id,
              decisionAt: context.now,
            },
          })
        } else if (uncertainWithinFile && ['VALID', 'WARNING'].includes(row.status)) {
          await database.prospectImportRow.updateMany({
            where: { id: row.id, importId: prospectImport.id, status: row.status },
            data: { status: 'DUPLICATE_REVIEW', warnings: ['within-file-potential-duplicate'] },
          })
        }
      }
      const stagedCount = await database.prospectImportRow.count({
        where: { importId: prospectImport.id },
      })
      if (stagedCount !== parsed.rows.length) throw new Error('Incomplete CSV row staging')
      // The duplicate pass above moves rows between statuses after the last staging batch
      // wrote the summary counters; refresh them so list views match the receipt.
      const statusCounts = await database.prospectImportRow.groupBy({
        by: ['status'],
        where: { importId: prospectImport.id },
        _count: { _all: true },
      })
      const countOf = (status: string) =>
        statusCounts.find((entry) => entry.status === status)?._count._all ?? 0
      const completed = await database.prospectImport.updateMany({
        where: { id: prospectImport.id, status: { in: ['DRAFT', 'DRY_RUN_READY'] } },
        data: {
          status: 'DRY_RUN_READY',
          totalRows: stagedCount,
          validRows: countOf('VALID'),
          warningRows: countOf('WARNING'),
          duplicateRows: countOf('DUPLICATE_REVIEW'),
          failedRows: countOf('FAILED'),
          packageManifest: {
            mcpCsv: true,
            suppliedMappingHash,
            suppliedFileIdHash,
            sourceRows: parsed.rows.length,
            retentionDigests,
            stagingComplete: true,
          },
        },
      })
      if (completed.count !== 1) throw new Error('CSV import changed during staging')
    } catch (error) {
      await database.prospectImport.updateMany({
        where: {
          id: prospectImport.id,
          status: { in: ['DRAFT', 'DRY_RUN_READY'] },
          packageManifest: { path: ['stagingComplete'], equals: false },
        },
        data: {
          packageManifest: {
            mcpCsv: true,
            suppliedMappingHash,
            suppliedFileIdHash,
            sourceRows: parsed.rows.length,
            retentionDigests,
            stagingComplete: false,
            stagingError:
              error instanceof Error && error.message === 'CSV source field retention mismatch'
                ? 'FIELD_RETENTION_MISMATCH'
                : 'STAGING_FAILED',
          },
        },
      })
      // A partial row set remains gated by the persisted completion marker. Do not
      // demote a concurrent same-operation stager that may just have completed it.
      return receipt(database, prospectImport.id, Boolean(existing))
    }
  return receipt(database, prospectImport.id, Boolean(existing))
}

async function receipt(
  database: OperatorCallContext['database'],
  importId: string,
  replayed: boolean,
) {
  const refreshed = await database.prospectImport.findUniqueOrThrow({ where: { id: importId } })
  const plan = await computeImportPlan(database, refreshed)
  const manifest = refreshed.packageManifest as {
    sourceRows?: number
    stagingComplete?: boolean
  } | null
  const sheets = await database.prospectImportSheet.findMany({
    where: { importId },
    select: { columns: true },
  })
  const mapping = refreshed.mapping as Record<string, string>
  const usedColumns = new Set(Object.values(mapping))
  const unmappedColumns = sheets.flatMap((sheet) =>
    (Array.isArray(sheet.columns) ? sheet.columns : []).filter(
      (column): column is string => typeof column === 'string' && !usedColumns.has(column),
    ),
  )
  const blocked =
    plan.counts.FAILED > 0 ||
    plan.counts.DUPLICATE_REVIEW > 0 ||
    plan.importableRows === 0 ||
    plan.rowTotal !== manifest?.sourceRows ||
    !manifest?.stagingComplete ||
    !['DRY_RUN_READY', 'APPROVED'].includes(refreshed.status)
  const recovery = !manifest?.stagingComplete
    ? ('RETRY_SAME_OPERATION_WITH_VALID_ATTACHMENT' as const)
    : plan.counts.FAILED > 0
      ? ('CORRECT_CSV' as const)
      : plan.counts.DUPLICATE_REVIEW > 0
        ? ('REVIEW_ROWS' as const)
        : null
  return {
    importId,
    replayed,
    blocked: refreshed.status === 'COMPLETE' ? false : blocked,
    status: refreshed.status,
    recovery,
    totalRows: manifest?.sourceRows ?? plan.rowTotal,
    stagedRows: plan.rowTotal,
    unmappedColumns,
    skippedDuplicates: plan.counts.SKIPPED,
    malformedRows: plan.counts.FAILED,
    unresolvedDuplicates: plan.counts.DUPLICATE_REVIEW,
    importableRows: plan.importableRows,
    addedRows: refreshed.importedRows,
    next: blocked
      ? null
      : {
          tool: 'crm.propose_import_commit' as const,
          args: {
            operationId: commitOperationId(importId),
            importId,
            fileHash: refreshed.fileHash,
            mappingHash: refreshed.mappingHash,
            planHash: plan.planHash,
            expectedRows: plan.importableRows,
          },
        },
  }
}

export const crmStageCsvImportTool: OperatorReadTool = {
  name: 'crm.stage_csv_import',
  capability: 'crm:propose',
  handler: (raw, context) => stageCsvImport(raw, context),
}
