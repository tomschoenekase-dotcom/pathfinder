import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

import {
  buildProspectStagingPackage,
  stableProspectExternalId,
} from './prospect-workbook-package.mjs'

const requireFromWorkers = createRequire(new URL('../apps/workers/package.json', import.meta.url))
const XLSX = requireFromWorkers('xlsx')

function workbook(rows) {
  const value = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(value, XLSX.utils.json_to_sheet(rows), 'Tier 1')
  return XLSX.write(value, { type: 'buffer', bookType: 'xlsx' })
}

test('stable identity is unchanged by row order and source-only columns', () => {
  const first = stableProspectExternalId({
    organizationName: 'Museum Group',
    venueName: 'Museum North',
    city: 'Chicago',
    region: 'IL',
    website: 'https://museum.example/about',
  })
  const second = stableProspectExternalId({
    notes: 'new research text',
    website: 'museum.example',
    region: 'IL',
    city: 'Chicago',
    venueName: 'Museum North',
    organizationName: 'Museum Group',
  })
  assert.equal(first, second)
})

test('shared domains do not collapse distinct locations', () => {
  const north = stableProspectExternalId({
    venueName: 'Museum North',
    city: 'Chicago',
    region: 'IL',
    website: 'museum.example',
  })
  const south = stableProspectExternalId({
    venueName: 'Museum South',
    city: 'Chicago',
    region: 'IL',
    website: 'museum.example',
  })
  assert.notEqual(north, south)
})

test('default selection excludes the derived summary sheet', () => {
  const value = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    value,
    XLSX.utils.json_to_sheet([{ Metric: 'Total', Value: 1 }]),
    '00 SUMMARY',
  )
  XLSX.utils.book_append_sheet(
    value,
    XLSX.utils.json_to_sheet([{ venue_name: 'Museum North', city: 'Chicago', state: 'IL' }]),
    'Chicago Metro',
  )
  const packageValue = buildProspectStagingPackage({
    workbookBuffer: XLSX.write(value, { type: 'buffer', bookType: 'xlsx' }),
    workbookName: 'source.xlsx',
  })
  assert.equal(packageValue.counts.PROSPECT, 1)
  assert.equal(packageValue.records[0].normalized.territory, 'Chicago Metro')
})

test('package preserves raw provenance and makes no fit, readiness, or send claim', () => {
  const packageValue = buildProspectStagingPackage({
    workbookBuffer: workbook([
      {
        Organization: 'Museum Group',
        'Venue Name': 'Museum North',
        City: 'Chicago',
        State: 'IL',
        Website: 'museum.example',
        Email: 'hello@museum.example',
        'Fit Score': '99',
      },
    ]),
    workbookName: 'PathFinder_Prospects_Tier1.xlsx',
    sheets: ['Tier 1'],
    createdAt: '2026-09-19T00:00:00.000Z',
  })
  assert.equal(packageValue.counts.PROSPECT, 1)
  assert.equal(packageValue.counts.CONTACT, 1)
  assert.equal(packageValue.counts.EVIDENCE, 1)
  assert.equal(packageValue.counts.DRAFT, 0)
  assert.deepEqual(packageValue.records[0].normalized.fitAttributes, {})
  assert.equal(packageValue.records[0].raw._source.originalRowNumber, 2)
  assert.equal(packageValue.records[1].status, 'SOURCE_ONLY_UNVERIFIED')
  assert.ok(!('emailReadiness' in packageValue.records[1].normalized))
  assert.ok(!('permissionState' in packageValue.records[1].normalized))
  const evidence = packageValue.records.find((record) => record.kind === 'EVIDENCE')
  assert.equal(evidence.normalized.sourceType, 'WORKBOOK')
})

test('identity collisions fail closed instead of silently merging rows', () => {
  const bytes = workbook([
    { 'Venue Name': 'Museum North', City: 'Chicago', State: 'IL' },
    { 'Venue Name': 'Museum North', City: 'Chicago', State: 'IL' },
  ])
  assert.throws(
    () => buildProspectStagingPackage({ workbookBuffer: bytes, workbookName: 'source.xlsx' }),
    /identity collision/u,
  )
})

function convertContact(fields) {
  return buildProspectStagingPackage({
    workbookBuffer: workbook([
      { venue_name: 'Museum North', city: 'Chicago', state: 'IL', ...fields },
    ]),
    workbookName: 'source.xlsx',
    createdAt: '2026-09-21T00:00:00.000Z',
  })
}

test('owner-only labels remain raw evidence, not contacts or organization names', () => {
  const value = convertContact({ owner_name: 'City Department' })
  assert.equal(value.counts.CONTACT, 0)
  assert.equal(value.records[0].normalized.organizationName, 'Museum North')
  assert.equal(value.records[0].raw.owner_name, 'City Department')
})

test('title-only source candidates are retained without inventing a person or address', () => {
  const value = convertContact({ contact_title: 'Director' })
  const contact = value.records.find((record) => record.kind === 'CONTACT')
  assert.equal(value.counts.CONTACT, 1)
  assert.deepEqual(contact.normalized, { title: 'Director', sourceRole: 'CONTACT_FIELDS_RECORDED' })
})

test('a public general inbox is not assigned to a named person by proximity', () => {
  const value = convertContact({ contact_name: 'Casey', general_email: 'INFO@museum.example' })
  const contacts = value.records.filter((record) => record.kind === 'CONTACT')
  assert.equal(contacts.length, 2)
  assert.equal(
    contacts.find((record) => record.normalized.fullName === 'Casey').normalized.email,
    undefined,
  )
  assert.equal(
    contacts.find((record) => record.normalized.email === 'info@museum.example').normalized
      .fullName,
    undefined,
  )
})

test('distinct general and named addresses are both retained, equal addresses coalesce once', () => {
  const different = convertContact({
    contact_email: 'casey@museum.example',
    general_email: 'info@museum.example',
  })
  assert.equal(different.counts.CONTACT, 2)
  assert.equal(
    new Set(different.records.map((record) => record.externalId)).size,
    different.records.length,
  )
  const same = convertContact({
    contact_email: 'INFO@museum.example',
    general_email: 'info@museum.example',
  })
  assert.equal(same.counts.CONTACT, 1)
})

test('source locations use physical worksheet rows after blank rows', () => {
  const value = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    value,
    XLSX.utils.aoa_to_sheet([
      ['venue_name', 'city', 'state'],
      ['Museum North', 'Chicago', 'IL'],
      [],
      ['Museum South', 'Chicago', 'IL'],
    ]),
    'Tier 1',
  )
  const result = buildProspectStagingPackage({
    workbookBuffer: XLSX.write(value, { type: 'buffer', bookType: 'xlsx' }),
    workbookName: 'source.xlsx',
  })
  assert.deepEqual(
    result.records
      .filter((record) => record.kind === 'PROSPECT')
      .map((record) => record.raw._source.originalRowNumber),
    [2, 4],
  )
})

test('nonblank rows without a complete stable identity fail with exact location, not silent loss', () => {
  assert.throws(
    () => convertContact({ venue_name: null, notes: 'source must remain accounted for' }),
    /Tier 1 row 2:.*venue name, city and state/u,
  )
  assert.throws(() => convertContact({ state: null }), /Tier 1 row 2:/u)
})

test('package is JSON-round-trip stable and hashes every original raw row', () => {
  const value = convertContact({ general_email: 'info@museum.example' })
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)))
  assert.match(value.records[0].raw._source.rawRowSha256, /^[a-f0-9]{64}$/u)
  assert.equal(value.records[0].raw._source.rawRowSha256, value.records[1].raw._source.rawRowSha256)
})

test('missing URLs, malformed email syntax and malformed dates remain raw unknown evidence', () => {
  const value = convertContact({ contact_email: 'not an address', research_date: 'not a date' })
  const contact = value.records.find((record) => record.kind === 'CONTACT')
  const evidence = value.records.find((record) => record.kind === 'EVIDENCE')
  assert.equal(contact.normalized.email, undefined)
  assert.equal(contact.raw.contact_email, 'not an address')
  assert.equal(evidence.normalized.url, undefined)
  assert.equal(evidence.normalized.researchedAt, undefined)
  assert.deepEqual(evidence.normalized.urls, [])
})

test('commas within source URLs are preserved', () => {
  const value = convertContact({
    source_urls: 'https://museum.example/places/a,b; https://museum.example/contact',
  })
  const evidence = value.records.find((record) => record.kind === 'EVIDENCE')
  assert.deepEqual(evidence.normalized.urls, [
    'https://museum.example/places/a,b',
    'https://museum.example/contact',
  ])
})
