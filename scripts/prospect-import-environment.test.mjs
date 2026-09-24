import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertLocalProspectImportEnvironment,
  assertSourceOnlyWorkbookPackage,
  CANONICAL_WORKBOOK_SHA256,
  LOCAL_CRM_DATABASE,
} from './prospect-import-environment.mjs'

const local = `postgresql://fixture:fixture@127.0.0.1:58617/${LOCAL_CRM_DATABASE}`
test('local environment returns only a redacted exact retained target', () => {
  assert.deepEqual(
    assertLocalProspectImportEnvironment({ DATABASE_URL: local, NODE_ENV: 'test' }),
    { host: '127.0.0.1', port: '58617', database: LOCAL_CRM_DATABASE },
  )
})
test('production, remote, ambiguous, wrong-port and wrong-database targets fail closed', () => {
  for (const DATABASE_URL of [
    '',
    local.replace('127.0.0.1', 'db.example'),
    local.replace('58617', '5432'),
    local.replace(LOCAL_CRM_DATABASE, 'production'),
    `${local}?host=db.example`,
    `${local}#fragment`,
  ]) {
    assert.throws(() => assertLocalProspectImportEnvironment({ DATABASE_URL }))
  }
  assert.throws(() =>
    assertLocalProspectImportEnvironment({ DATABASE_URL: local, NODE_ENV: 'production' }),
  )
  assert.throws(() =>
    assertLocalProspectImportEnvironment({
      DATABASE_URL: local,
      DIRECT_DATABASE_URL: local.replace('127.0.0.1', 'db.example'),
    }),
  )
})
test('commit contract rejects another workbook, draft authority and overwrite/link requests', () => {
  const base = {
    sourceWorkbook: { sha256: CANONICAL_WORKBOOK_SHA256 },
    records: [
      {
        kind: 'PROSPECT',
        status: 'SOURCE_ONLY_UNVERIFIED',
        normalized: { duplicateOutcome: 'KEEP_DISTINCT' },
      },
    ],
  }
  assert.doesNotThrow(() => assertSourceOnlyWorkbookPackage(base))
  assert.throws(() =>
    assertSourceOnlyWorkbookPackage({ ...base, sourceWorkbook: { sha256: 'a'.repeat(64) } }),
  )
  for (const record of [
    { kind: 'DRAFT', status: 'SOURCE_ONLY_UNVERIFIED', normalized: {} },
    { ...base.records[0], normalized: { duplicateOutcome: 'UPDATE' } },
    {
      ...base.records[0],
      normalized: { duplicateOutcome: 'KEEP_DISTINCT', existingVenueId: 'other' },
    },
  ])
    assert.throws(() => assertSourceOnlyWorkbookPackage({ ...base, records: [record] }))
})
