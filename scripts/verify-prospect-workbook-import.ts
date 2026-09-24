import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'

import { parseProspectStagingPackage } from '../packages/contracts/src/prospect-staging-package-node'
// @ts-expect-error Independently tested local ESM safety boundary.
import {
  assertLocalProspectImportEnvironment,
  assertSourceOnlyWorkbookPackage,
} from './prospect-import-environment.mjs'

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const stable = (prefix: string, workbook: string, externalId: string) =>
  `${prefix}_${hash(`${workbook}\n${externalId}`).slice(0, 24)}`
const optionalText = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

async function main() {
  const args = process.argv.slice(2)
  const option = (name: string) => {
    const index = args.indexOf(name)
    if (index < 0 || !args[index + 1]) throw new Error(`Required: ${name}`)
    return path.resolve(args[index + 1]!)
  }
  const target = assertLocalProspectImportEnvironment(process.env)
  const outputPath = option('--receipt')
  const bytes = await readFile(option('--package'))
  const parsed = parseProspectStagingPackage(JSON.parse(bytes.toString('utf8')))
  assertSourceOnlyWorkbookPackage(parsed.package)
  const pkg = parsed.package
  const workbook = pkg.sourceWorkbook.sha256
  const expected = new Map(pkg.records.map((record) => [record.externalId, record]))
  const prospects = pkg.records.filter((record) => record.kind === 'PROSPECT')
  let checks = 0
  const failures: string[] = []
  const check = (condition: boolean, label: string) => {
    checks += 1
    if (!condition && failures.length < 30) failures.push(label)
  }
  const equal = (actual: unknown, wanted: unknown, label: string) =>
    check(isDeepStrictEqual(actual, wanted), label)
  const { db } = await import('../packages/db/src/client')
  try {
    const imports = await db.prospectImport.findMany({ where: { packageHash: parsed.packageHash } })
    if (imports.length !== 1)
      throw new Error(`Expected one exact admitted package, found ${imports.length}`)
    const imported = imports[0]!
    equal(imported.status, 'COMPLETE', 'native import complete')
    equal(imported.sourceWorkbookHash, workbook, 'native workbook hash')
    equal(imported.totalRows, 16725, 'native source-row total')
    equal(imported.validRows, 16725, 'native accepted source-row total')
    equal(imported.importedRows, 16725, 'native imported source-row total')
    equal(imported.failedRows, 0, 'native rejected source-row total')
    equal(object(imported.packageManifest).counts, pkg.counts, 'native immutable manifest counts')
    const [organizations, venues, contacts, territories, opportunities] = await Promise.all([
      db.prospectOrganization.findMany(),
      db.prospectVenue.findMany(),
      db.prospectContact.findMany(),
      db.prospectTerritory.findMany(),
      db.prospectOpportunity.findMany(),
    ])
    const organizationsById = new Map(organizations.map((row) => [row.id, row]))
    const venuesById = new Map(venues.map((row) => [row.id, row]))
    const contactsById = new Map(contacts.map((row) => [row.id, row]))
    const territoriesById = new Map(territories.map((row) => [row.id, row]))
    equal(organizations.length, 16725, 'one native prospect organization per source identity')
    equal(venues.length, 16725, 'one native venue per source identity')
    equal(contacts.length, pkg.counts.CONTACT, 'expanded contact record count')
    equal(territories.length, 85, 'native territory count')
    equal(opportunities.length, 16725, 'existing opportunity owner count')
    check(
      opportunities.every((row) => row.stage === 'DISCOVERED'),
      'source-only opportunity stages',
    )
    const seen = new Set<string>()
    const sourceBindings = new Map<string, string>()
    const kinds: Record<string, number> = {}
    let cursor: string | undefined
    while (true) {
      const rows = await db.prospectImportSourceRecord.findMany({
        where: { importId: imported.id },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
      if (!rows.length) break
      for (const row of rows) {
        const record = expected.get(row.externalRecordId)
        if (!record) {
          check(false, `unexpected admitted source record ${row.externalRecordId}`)
          continue
        }
        check(
          !seen.has(row.externalRecordId),
          `no duplicate source identity ${row.externalRecordId}`,
        )
        seen.add(row.externalRecordId)
        sourceBindings.set(row.externalRecordId, row.id)
        kinds[row.recordKind] = (kinds[row.recordKind] ?? 0) + 1
        equal(row.processingStatus, 'COMPLETE', `processing status ${record.externalId}`)
        equal(row.recordKind, record.kind, `record kind ${record.externalId}`)
        equal(row.sourceWorkbookHash, workbook, `source hash ${record.externalId}`)
        equal(row.parentExternalId, record.parentExternalId ?? null, `parent ${record.externalId}`)
        equal(row.rawPayload, record.raw, `complete raw payload ${record.externalId}`)
        equal(
          row.normalizedPayload,
          record.normalized,
          `complete normalized payload ${record.externalId}`,
        )
        equal(row.sourceStatus, record.status, `unverified source status ${record.externalId}`)
        equal(
          row.recordHash,
          hash(`${parsed.packageHash}:${record.kind}:${record.externalId}`),
          `native record hash ${record.externalId}`,
        )
        check(
          row.claimToken === null &&
            row.claimOwner === null &&
            row.claimExpiresAt === null &&
            row.errorCode === null,
          `no retained lease/error ${record.externalId}`,
        )
        const parent = record.kind === 'PROSPECT' ? record.externalId : record.parentExternalId!
        equal(
          row.canonicalOrganizationId,
          stable('porg', workbook, parent),
          `stable organization ID ${record.externalId}`,
        )
        equal(
          row.canonicalVenueId,
          stable('pvenue', workbook, parent),
          `stable venue ID ${record.externalId}`,
        )
        if (record.kind === 'CONTACT')
          equal(
            row.canonicalContactId,
            stable('pcontact', workbook, record.externalId),
            `stable contact ID ${record.externalId}`,
          )
        if (record.kind === 'EVIDENCE')
          equal(
            row.canonicalEvidenceId,
            stable('pevidence', workbook, record.externalId),
            `stable evidence ID ${record.externalId}`,
          )
      }
      cursor = rows.at(-1)!.id
    }
    equal(seen.size, pkg.records.length, 'all package records admitted, mapped and read back')
    const sharedWebsites = new Map<string, string[]>()
    const territoryCounts: Record<string, number> = {}
    const examples: unknown[] = []
    const exampleTerritories = new Set<string>()
    const contactParents = new Set(
      pkg.records
        .filter((record) => record.kind === 'CONTACT')
        .map((record) => record.parentExternalId),
    )
    const ownerOnly: unknown[] = []
    const contactWithoutUrl: unknown[] = []
    for (const record of prospects) {
      const normalized = record.normalized
      const org = organizationsById.get(stable('porg', workbook, record.externalId))
      const venue = venuesById.get(stable('pvenue', workbook, record.externalId))
      if (!org || !venue) {
        check(false, `missing canonical prospect ${record.externalId}`)
        continue
      }
      equal(org.canonicalName, normalized.organizationName, `prospect name ${record.externalId}`)
      equal(venue.name, normalized.venueName, `venue name ${record.externalId}`)
      equal(venue.organizationId, org.id, `venue relationship ${record.externalId}`)
      equal(venue.city, optionalText(normalized.city), `city ${record.externalId}`)
      equal(venue.region, optionalText(normalized.region), `state ${record.externalId}`)
      equal(venue.website, optionalText(normalized.website), `website ${record.externalId}`)
      equal(venue.fitAttributes, {}, `no imported score authority ${record.externalId}`)
      equal(
        org.researchProvenance,
        [{ importId: imported.id, externalRecordId: record.externalId }],
        `organization provenance ${record.externalId}`,
      )
      equal(
        venue.researchSources,
        [{ importId: imported.id, externalRecordId: record.externalId }],
        `venue provenance ${record.externalId}`,
      )
      const territory = territoriesById.get(venue.territoryId ?? '')
      equal(territory?.name, normalized.territory, `territory ${record.externalId}`)
      equal(org.territoryId, venue.territoryId, `consistent territory ${record.externalId}`)
      const territoryName = String(normalized.territory)
      territoryCounts[territoryName] = (territoryCounts[territoryName] ?? 0) + 1
      const rawWebsite = optionalText(record.raw.website)
      if (rawWebsite)
        sharedWebsites.set(rawWebsite, [...(sharedWebsites.get(rawWebsite) ?? []), venue.id])
      const locator = object(record.raw._source)
      const sample = {
        territory: territoryName,
        row: locator.originalRowNumber,
        externalId: record.externalId,
        organizationId: org.id,
        venueId: venue.id,
        name: venue.name,
        city: venue.city,
        state: venue.region,
        website: venue.website,
        contactState: contactParents.has(record.externalId) ? 'RECORDED_UNVERIFIED' : 'UNKNOWN',
        sourceLocator: locator,
      }
      if (!exampleTerritories.has(territoryName)) {
        examples.push(sample)
        exampleTerritories.add(territoryName)
      }
      const contactFields = [
        'general_email',
        'contact_name',
        'contact_title',
        'contact_email',
        'phone',
      ]
      if (
        optionalText(record.raw.owner_name) &&
        !contactFields.some((field) => optionalText(record.raw[field]))
      ) {
        check(
          !contacts.some((contact) => contact.organizationId === org.id),
          `owner-only row has no contact ${record.externalId}`,
        )
        ownerOnly.push(sample)
      }
      if (contactParents.has(record.externalId) && !optionalText(record.raw.source_urls))
        contactWithoutUrl.push(sample)
    }
    equal(ownerOnly.length, 5, 'owner-name-only cases')
    equal(contactWithoutUrl.length, 2, 'contact rows lacking source URL')
    equal(contactParents.size, 6183, 'contact-bearing source rows')
    let sharedGroups = 0
    for (const ids of sharedWebsites.values())
      if (ids.length > 1) {
        sharedGroups += 1
        equal(new Set(ids).size, ids.length, 'shared website locations remain distinct')
      }
    equal(sharedGroups, 1005, 'all shared website groups read back')
    const emailIdentities = new Set<string>()
    for (const record of pkg.records.filter((row) => row.kind === 'CONTACT')) {
      const contact = contactsById.get(stable('pcontact', workbook, record.externalId))
      if (!contact) {
        check(false, `missing contact ${record.externalId}`)
        continue
      }
      equal(
        contact.fullName,
        optionalText(record.normalized.fullName),
        `contact name ${record.externalId}`,
      )
      equal(
        contact.title,
        optionalText(record.normalized.title),
        `contact title ${record.externalId}`,
      )
      equal(
        contact.email,
        optionalText(record.normalized.email),
        `contact email ${record.externalId}`,
      )
      equal(
        contact.phone,
        optionalText(record.normalized.phone),
        `contact phone ${record.externalId}`,
      )
      equal(contact.emailReadiness, 'UNKNOWN', `unknown readiness ${record.externalId}`)
      equal(contact.permissionState, 'UNKNOWN', `unknown permission ${record.externalId}`)
      equal(
        contact.provenance,
        [
          {
            importId: imported.id,
            externalRecordId: record.externalId,
            sourceRole: record.normalized.sourceRole,
            verification: 'UNKNOWN',
          },
        ],
        `contact provenance ${record.externalId}`,
      )
      if (contact.email) {
        const key = `${contact.organizationId}\n${contact.email}`
        check(
          !emailIdentities.has(key),
          `no duplicated contact email per venue ${record.externalId}`,
        )
        emailIdentities.add(key)
      }
    }
    let evidenceCursor: string | undefined
    let evidenceCount = 0
    const evidenceById = new Map(
      pkg.records
        .filter((record) => record.kind === 'EVIDENCE')
        .map((record) => [stable('pevidence', workbook, record.externalId), record]),
    )
    while (true) {
      const rows = await db.prospectSourceEvidence.findMany({
        orderBy: { id: 'asc' },
        take: 500,
        ...(evidenceCursor ? { cursor: { id: evidenceCursor }, skip: 1 } : {}),
      })
      if (!rows.length) break
      for (const row of rows) {
        evidenceCount += 1
        const record = evidenceById.get(row.id)
        if (!record) {
          check(false, `unexpected evidence ${row.id}`)
          continue
        }
        equal(row.sourceType, 'WORKBOOK', `evidence remains workbook-sourced ${record.externalId}`)
        equal(row.sourceUrl, optionalText(record.normalized.url), `source URL ${record.externalId}`)
        equal(row.sourceLabel, record.normalized.label, `source label ${record.externalId}`)
        equal(
          row.capturedValue,
          {
            raw: record.raw,
            normalized: record.normalized,
            importSourceRecordId: sourceBindings.get(record.externalId),
          },
          `full evidence/lineage payload ${record.externalId}`,
        )
        equal(
          row.researchedAt?.toISOString() ?? null,
          record.normalized.researchedAt
            ? new Date(String(record.normalized.researchedAt)).toISOString()
            : null,
          `source research date ${record.externalId}`,
        )
      }
      evidenceCursor = rows.at(-1)!.id
    }
    equal(evidenceCount, 16725, 'source evidence count')
    const forbidden = {
      campaigns: await db.prospectOutreachCampaign.count(),
      drafts: await db.prospectOutreachDraft.count(),
      sendBatches: await db.prospectSendBatch.count(),
      sendItems: await db.prospectSendItem.count(),
      sendOutbox: await db.prospectSendOutbox.count(),
      messages: await db.prospectEmailMessage.count(),
      threads: await db.prospectEmailThread.count(),
      followups: await db.prospectFollowup.count(),
    }
    check(
      Object.values(forbidden).every((value) => value === 0),
      'no campaign, draft, send, correspondence or follow-up created',
    )
    const receipt = {
      schema: 'torchiko.local-crm-import-readback/v1',
      observedAt: new Date().toISOString(),
      passed: failures.length === 0,
      checks,
      failures,
      target,
      importId: imported.id,
      sourceSha256: workbook,
      packageHash: parsed.packageHash,
      packageFileSha256: hash(bytes),
      counts: {
        sourceRows: pkg.sourceWorkbook.rowCount,
        packageRecords: pkg.records.length,
        acceptedSourceRows: imported.importedRows,
        rejectedSourceRows: imported.failedRows,
        skippedSourceRows: object(imported.reconciliation).sourceRowsSkipped,
        organizations: organizations.length,
        venues: venues.length,
        territories: territories.length,
        contacts: contacts.length,
        contactSourceRows: contactParents.size,
        sourceRecords: seen.size,
        sourceEvidence: evidenceCount,
        sharedWebsiteGroups: sharedGroups,
      },
      kinds,
      forbidden,
      territoryCounts,
      examples,
      ownerOnly,
      contactWithoutUrl,
      idempotencyScope:
        'Canonical IDs use the retained workbook SHA namespace plus stable venue/city/state-derived external IDs. Cross-workbook refresh requires an explicit reviewed linking policy; it is not automatic.',
      contactMeaning:
        'All contact candidates have UNKNOWN permission and readiness. Source presence is not verification, deliverability, ownership, or consent.',
    }
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(
      `${JSON.stringify({ passed: receipt.passed, checks, failures, counts: receipt.counts, forbidden, receipt: outputPath }, null, 2)}\n`,
    )
    if (failures.length) process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Readback failed'
  process.stderr.write(
    `${message.replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[redacted database URL]')}\n`,
  )
  process.exitCode = 1
})
