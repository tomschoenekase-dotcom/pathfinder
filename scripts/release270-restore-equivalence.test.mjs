import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertRelease270RestoreEquivalent,
  RESTORE_SECURITY_SQL,
} from './lib/release270-restore-equivalence.mjs'
const original = () => ({
  observedAt: 'original',
  existingSecurityHash: 'raw-before',
  ledger: [{ id: 'retained', timestamp: '2026-10-29T00:00:00.123456Z' }],
  tables: [{ name: 'fictional', hash: 'original' }],
  catalog: {
    enums: [
      { typname: 'Fictional', enumlabel: 'A', enumsortorder: 1 },
      { typname: 'Fictional', enumlabel: 'B', enumsortorder: 1.5 },
    ],
    constraints: [
      {
        definition:
          "CHECK (v = ANY (ARRAY['a'::character varying, 'b'::character varying]::text[]))",
      },
    ],
  },
})
const security = [
  {
    identity: 'schema:public',
    owner: 'fictional-owner',
    grants: '[{"grantee":"PUBLIC","privilege":"USAGE","grantable":false}]',
  },
]
test('logical restore admits only reviewed enum rank and literal array cast normalization with equivalent security', () => {
  const before = original(),
    restored = structuredClone(before)
  restored.observedAt = 'restored'
  restored.catalog.enums[1].enumsortorder = 2
  restored.catalog.constraints[0].definition =
    "CHECK (v = ANY (ARRAY['a'::character varying::text, 'b'::character varying::text]))"
  assert.equal(
    assertRelease270RestoreEquivalent(before, restored, security, structuredClone(security))
      .rawSecurityChanged,
    false,
  )
})

test('unexplained raw security hash difference cannot be hidden by supplied equivalent grants', () => {
  const before = original(),
    restored = structuredClone(before)
  restored.existingSecurityHash = 'unexplained-difference'
  assert.throws(
    () => assertRelease270RestoreEquivalent(before, restored, security, structuredClone(security)),
    /raw security difference requires independent review/u,
  )
})

test('diagnostics retain null/raw ACL, object kinds, columns and default privileges without writes', () => {
  for (const field of [
    '"rawAcl"',
    '"aclIsNull"',
    '"explicitGrants"',
    '"diagnosticEffectiveGrants"',
    "'column:'",
    "'defaults:'",
    "'type:'",
  ])
    assert.ok(RESTORE_SECURITY_SQL.includes(field))
  assert.match(RESTORE_SECURITY_SQL, /^WITH objects AS/u)
  assert.ok(!/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE)\b/u.test(RESTORE_SECURITY_SQL))
})
test('restore still refuses data, physical ledger, logical constraints, enum order and effective grants drift', () => {
  for (const mutate of [
    (r) => {
      r.tables[0].hash = 'changed'
    },
    (r) => {
      r.ledger[0].timestamp += '0'
    },
    (r) => {
      r.catalog.enums[1].enumlabel = 'C'
    },
    (r) => {
      r.catalog.constraints[0].definition = 'CHECK (true)'
    },
  ]) {
    const before = original(),
      restored = structuredClone(before)
    mutate(restored)
    assert.throws(() => assertRelease270RestoreEquivalent(before, restored, security, security))
  }
  const changed = structuredClone(security)
  changed[0].grants = '[]'
  assert.throws(
    () => assertRelease270RestoreEquivalent(original(), original(), security, changed),
    /effective security changed/u,
  )
  assert.throws(
    () => assertRelease270RestoreEquivalent(original(), original(), [], []),
    /security receipt required/u,
  )
})
