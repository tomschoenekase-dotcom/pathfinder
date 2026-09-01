import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateFounderEvidencePackage } from './validate-lib.mjs'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function fixture() {
  const history = [
    ['add-hours', 'addition', null, { hours: '9-5' }],
    ['correct-hours', 'correction', { hours: '9-5' }, { hours: '9-6' }],
    ['supersede-policy', 'supersession', { policy: 'old' }, { policy: 'new' }],
    ['temporary-closure', 'temporary', { closed: false }, { closed: true }],
    ['conflicting-map', 'conflict', { floor: 1 }, { candidates: [1, 2] }],
    ['duplicate-hours', 'duplicate-no-op', { hours: '9-6' }, { hours: '9-6' }],
  ].map(([stableKey, changeClass, before, after]) => ({
    stableKey,
    changeClass,
    effectiveAt: '2026-09-01T12:00:00Z',
    sourceReference: `reviewed-source-${stableKey}`,
    before,
    after,
    ...(changeClass === 'temporary' ? { temporaryEndAt: '2026-09-02T12:00:00Z' } : {}),
  }))
  return {
    schemaVersion: 1,
    fixtureId: 'founder-approved-synthetic-venue-v1',
    synthetic: true,
    customerData: false,
    venue: { stableKey: 'synthetic-venue', name: 'Synthetic Venue' },
    approval: {
      status: 'APPROVED',
      approvedByReference: 'founder-review-receipt-1',
      approvedAt: '2026-09-01T11:00:00Z',
      approvedScopes: ['VIS-06', 'VIS-07', 'UPD-01', 'UPD-02'],
    },
    topology: {
      reviewedAt: '2026-09-01T11:00:00Z',
      reviewerReference: 'founder-review-receipt-1',
      floors: [{ stableKey: 'main-floor', name: 'Main Floor' }],
      locations: [
        {
          stableKey: 'entry',
          floorStableKey: 'main-floor',
          kind: 'ENTRANCE',
          displayName: 'Entry',
        },
        {
          stableKey: 'gallery',
          floorStableKey: 'main-floor',
          kind: 'EXHIBIT',
          displayName: 'Gallery',
        },
      ],
      connections: [
        {
          from: 'entry',
          to: 'gallery',
          kind: 'WALKWAY',
          bidirectional: true,
          accessible: true,
          directions: 'Follow the wide hall from the entry to the gallery.',
          reviewedAt: '2026-09-01T11:00:00Z',
        },
      ],
    },
    media: [
      {
        stableKey: 'gallery-orientation',
        localPath: 'gallery.png',
        mimeType: 'image/png',
        byteSize: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        altText: 'Synthetic gallery orientation image.',
        sourceName: 'Founder-approved synthetic test asset',
        reviewedAt: '2026-09-01T11:00:00Z',
        rights: {
          basis: 'VENUE_OWNED',
          statement: 'Synthetic asset approved for staging-only product proof.',
          evidenceReference: 'founder-review-receipt-1',
        },
      },
    ],
    history,
    exercise: {
      targetEnvironment: 'railway-staging',
      publicationAuthority: false,
      providerCallsAllowed: false,
      requiredLifecycleActions: ['approve', 'apply', 'revert', 'schedule', 'deactivate'],
    },
  }
}

async function workspace() {
  const directory = await mkdtemp(path.join(tmpdir(), 'torchiko-founder-evidence-'))
  await writeFile(path.join(directory, 'gallery.png'), png)
  return directory
}

test('accepts a complete approved synthetic package and returns a bounded receipt', async () => {
  const packageDirectory = await workspace()
  const receipt = await validateFounderEvidencePackage(fixture(), { packageDirectory })
  assert.deepEqual(receipt.approvedScopes, ['VIS-06', 'VIS-07', 'UPD-01', 'UPD-02'])
  assert.equal(receipt.topology.locations, 2)
  assert.equal(receipt.media[0].byteSize, png.length)
  assert.equal(receipt.exercise.publicationAuthority, false)
  assert.match(receipt.packageSha256, /^[a-f0-9]{64}$/)
})

test('package receipt digest is stable across object property order', async () => {
  const packageDirectory = await workspace()
  const value = fixture()
  const reordered = Object.fromEntries(Object.entries(value).reverse())
  const [first, second] = await Promise.all([
    validateFounderEvidencePackage(value, { packageDirectory }),
    validateFounderEvidencePackage(reordered, { packageDirectory }),
  ])
  assert.equal(first.packageSha256, second.packageSha256)
})

test('checked-in template remains explicitly pending and non-customer', async () => {
  const template = JSON.parse(
    await readFile(new URL('./template.pending.json', import.meta.url), 'utf8'),
  )
  assert.equal(template.approval.status, 'PENDING')
  assert.equal(template.synthetic, true)
  assert.equal(template.customerData, false)
  await assert.rejects(
    () => validateFounderEvidencePackage(template, { packageDirectory: process.cwd() }),
    /approval\.status must be APPROVED/,
  )
})

test('CLI rejection is bounded and does not emit a stack or input path', () => {
  const command = fileURLToPath(new URL('./validate.mjs', import.meta.url))
  const template = fileURLToPath(new URL('./template.pending.json', import.meta.url))
  const result = spawnSync(process.execPath, [command, template], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    'Founder evidence package rejected: approval.status must be APPROVED',
  )
  assert.doesNotMatch(result.stderr, /[\\/]scripts[\\/]|\bat\s/)
})

for (const [name, mutate, pattern] of [
  ['pending approval', (value) => (value.approval.status = 'PENDING'), /approval\.status/],
  ['customer data', (value) => (value.customerData = true), /synthetic must be true/],
  ['database identifier', (value) => (value.venue.venueId = 'database-id'), /venueId is forbidden/],
  ['missing scope', (value) => value.approval.approvedScopes.pop(), /approvedScopes must include/],
  [
    'publication authority',
    (value) => (value.exercise.publicationAuthority = true),
    /must not grant/,
  ],
  ['provider calls', (value) => (value.exercise.providerCallsAllowed = true), /must not grant/],
  [
    'disconnected topology',
    (value) =>
      value.topology.locations.push({
        stableKey: 'cafe',
        floorStableKey: 'main-floor',
        kind: 'AMENITY',
        displayName: 'Cafe',
      }),
    /connected reviewed graph/,
  ],
  ['missing change class', (value) => value.history.pop(), /history must cover all change classes/],
  [
    'invalid temporary window',
    (value) =>
      (value.history.find((entry) => entry.changeClass === 'temporary').temporaryEndAt =
        '2026-08-31T12:00:00Z'),
    /temporaryEndAt must be after effectiveAt/,
  ],
  [
    'approval before review',
    (value) => (value.approval.approvedAt = '2026-08-31T12:00:00Z'),
    /approvedAt must be at or after/,
  ],
  [
    'changed duplicate',
    (value) => (value.history.at(-1).after = { hours: '10-6' }),
    /must preserve an identical value/,
  ],
  [
    'wrong media hash',
    (value) => (value.media[0].sha256 = '0'.repeat(64)),
    /does not match the local file/,
  ],
  [
    'path traversal',
    (value) => (value.media[0].localPath = '../gallery.png'),
    /must remain inside/,
  ],
]) {
  test(`rejects ${name}`, async () => {
    const packageDirectory = await workspace()
    const value = fixture()
    mutate(value)
    await assert.rejects(() => validateFounderEvidencePackage(value, { packageDirectory }), pattern)
  })
}
