import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  filterCandidates,
  findLatestSnapshot,
  findOrganization,
  freshnessLine,
  isUncontacted,
  parseArgs,
  parseSnapshot,
  run,
} from './torchiko-crm-snapshot.mjs'

function organization(id, overrides = {}) {
  return {
    id,
    name: `Sample ${id} Museum`,
    type: 'museum',
    headquarters: { city: 'Sampleton', region: 'IL', country: 'US' },
    stage: 'RESEARCHED',
    tags: [],
    venues: [
      {
        id: `${id}-v`,
        name: `Sample ${id}`,
        type: 'museum',
        city: 'Sampleton',
        region: 'IL',
        estimatedSize: 'M',
        fit: {},
      },
    ],
    contacts: [{ id: `${id}-c`, email: `${id}@example.com`, suppressed: false }],
    outreach: {
      everContacted: false,
      doNotContact: false,
      crmDrafts: 0,
      campaigns: [],
      duplicateReview: null,
    },
    ...overrides,
  }
}

const generatedAt = '2026-09-28T12:00:00.000Z'
const snapshot = {
  schemaVersion: 1,
  generatedAt,
  counts: { organizations: 5, venues: 5, contacts: 5, suppressedContacts: 1 },
  organizations: [
    organization('fresh'),
    organization('sent', { outreach: { ...organization('x').outreach, everContacted: true } }),
    organization('blocked', {
      contacts: [{ id: 'b-c', email: null, suppressed: true }],
      outreach: { ...organization('x').outreach, doNotContact: true },
    }),
    organization('dupe', { outreach: { ...organization('x').outreach, duplicateReview: 'OPEN' } }),
    organization('far', {
      headquarters: { city: 'Otherville', region: 'WI', country: 'US' },
      venues: [
        {
          id: 'far-v',
          name: 'Far',
          type: 'stadium',
          city: 'Otherville',
          region: 'WI',
          estimatedSize: 'L',
          fit: {},
        },
      ],
    }),
  ],
}

test('uncontacted excludes contacted, suppressed, duplicate and settled organizations', () => {
  assert.deepEqual(
    snapshot.organizations.filter(isUncontacted).map((org) => org.id),
    ['fresh', 'far'],
  )
  assert.equal(isUncontacted(organization('won', { stage: 'WON' })), false)
  assert.equal(
    isUncontacted(
      organization('drafted', { outreach: { ...organization('x').outreach, crmDrafts: 1 } }),
    ),
    false,
  )
})

test('candidate filters combine city, region, type, size and limit', () => {
  const ids = (filters) =>
    filterCandidates(snapshot, { limit: 50, ...filters }).map((org) => org.id)
  assert.deepEqual(ids({ city: 'sampleton', uncontacted: true }), ['fresh'])
  assert.deepEqual(ids({ region: 'wi' }), ['far'])
  assert.deepEqual(ids({ type: 'stadium' }), ['far'])
  assert.deepEqual(ids({ size: 'm', uncontacted: true }), ['fresh'])
  assert.equal(ids({ limit: 2 }).length, 2)
})

test('org lookup prefers an exact id, then a name fragment', () => {
  assert.deepEqual(
    findOrganization(snapshot, 'far').map((org) => org.id),
    ['far'],
  )
  assert.deepEqual(
    findOrganization(snapshot, 'SAMPLE BLOCKED').map((org) => org.id),
    ['blocked'],
  )
})

test('freshness warns only after 48 hours', () => {
  assert.doesNotMatch(freshnessLine(snapshot, new Date('2026-09-29T12:00:00Z')), /WARNING/u)
  assert.match(freshnessLine(snapshot, new Date('2026-10-01T12:00:00Z')), /WARNING/u)
})

test('rejects an unknown schema and bad arguments', () => {
  assert.throws(() => parseSnapshot('{"schemaVersion":2,"organizations":[]}'), /Unsupported/u)
  assert.throws(() => parseArgs(['candidates', '--city']), /needs a value/u)
  assert.throws(() => parseArgs(['candidates', '--limit', '0']), /positive integer/u)
  assert.throws(() => parseArgs(['candidates', '--bogus']), /Unknown option/u)
})

test('reads the newest snapshot from the folder and never prints suppressed emails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crm-snapshot-test-'))
  await writeFile(
    path.join(directory, 'torchiko-crm-snapshot-2026-09-01T00-00-00-000Z.json'),
    JSON.stringify({ ...snapshot, generatedAt: '2026-09-01T00:00:00.000Z', organizations: [] }),
  )
  await writeFile(
    path.join(directory, 'torchiko-crm-snapshot-2026-09-28T12-00-00-000Z.json'),
    JSON.stringify(snapshot),
  )
  await writeFile(path.join(directory, 'notes.json'), '{}')
  assert.match(await findLatestSnapshot(directory), /2026-09-28T12-00-00-000Z/u)

  const lines = []
  await run(['candidates', '--limit', '10'], {
    env: { TORCHIKO_CRM_SNAPSHOT_DIR: directory },
    now: new Date('2026-09-28T13:00:00Z'),
    write: (line) => lines.push(line),
  })
  const output = lines.join('\n')
  assert.match(output, /^Snapshot 2026-09-28T12:00:00.000Z \((1 hour old)\)\./u)
  assert.match(output, /5 match\(es\)/u)
  assert.match(output, /fresh@example.com/u)
  assert.match(output, /Sample blocked Museum .*no reachable email/u)

  const json = []
  await run(['summary', '--json'], {
    env: { TORCHIKO_CRM_SNAPSHOT_DIR: directory },
    now: new Date('2026-10-02T00:00:00Z'),
    write: (line) => json.push(line),
  })
  assert.deepEqual(
    (({ stale, uncontacted, doNotContact }) => ({ stale, uncontacted, doNotContact }))(
      JSON.parse(json[0]),
    ),
    { stale: true, uncontacted: 2, doNotContact: 1 },
  )
})

test('explains a missing snapshot folder', async () => {
  await assert.rejects(
    run(['summary'], {
      env: { TORCHIKO_CRM_SNAPSHOT_DIR: path.join(tmpdir(), 'no-such-crm-dir-xyz') },
      write: () => {},
    }),
    /Download one from \/admin\/prospects/u,
  )
})
