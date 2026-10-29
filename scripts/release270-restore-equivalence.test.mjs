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

function reviewedPair() {
  const executor = 'pathfinder_guest_disposition_executor'
  const grants = [
    { grantee: 'PUBLIC', grantor: executor, grantable: false, privilege: 'EXECUTE' },
    { grantee: executor, grantor: executor, grantable: false, privilege: 'EXECUTE' },
  ]
  const source = [
    {
      identity:
        'function:pathfinder_guest_disposition_row_blocked(table_name text, row_value jsonb)',
      owner: executor,
      kind: 'function',
      defaultKind: 'f',
      rawAcl: `{${executor}=X/${executor},=X/${executor}}`,
      aclIsNull: false,
      explicitGrants: JSON.stringify(grants),
      diagnosticEffectiveGrants: grants,
    },
    {
      identity: 'column:fictional.value',
      owner: 'fictional-owner',
      kind: 'column',
      defaultKind: null,
      rawAcl: null,
      aclIsNull: true,
      explicitGrants: '[]',
      diagnosticEffectiveGrants: null,
    },
  ]
  const restored = structuredClone(source)
  Object.assign(restored[0], { rawAcl: null, aclIsNull: true, explicitGrants: '[]' })
  const before = original(),
    after = structuredClone(before)
  after.existingSecurityHash = 'reviewed-raw-representation-change'
  return { before, after, source, restored }
}

test('only observed named function default-ACL representation can explain raw hash drift', () => {
  const f = reviewedPair()
  const result = assertRelease270RestoreEquivalent(f.before, f.after, f.source, f.restored)
  assert.equal(result.rawSecurityChanged, true)
  assert.equal(result.normalizedSecurityDifferences, 1)
  assert.equal(
    assertRelease270RestoreEquivalent(f.after, f.before, f.restored, f.source)
      .normalizedSecurityDifferences,
    1,
  )
})

test('allowlisted representation never excuses real grant/revoke, grant option, grantor, owner or column drift', () => {
  for (const mutate of [
    (f) => {
      f.restored[0].diagnosticEffectiveGrants.pop()
    },
    (f) => {
      f.restored[0].diagnosticEffectiveGrants.push({
        grantee: 'fictional-reader',
        grantor: 'fictional-owner',
        grantable: false,
        privilege: 'EXECUTE',
      })
    },
    (f) => {
      f.restored[0].diagnosticEffectiveGrants[0].grantable = true
    },
    (f) => {
      f.restored[0].diagnosticEffectiveGrants[0].grantor = 'fictional-other-grantor'
    },
    (f) => {
      f.restored[0].owner = 'fictional-other-owner'
    },
    (f) => {
      f.restored[0].defaultKind = 'r'
    },
    (f) => {
      f.restored[0].kind = 'type'
    },
    (f) => {
      f.source[0].identity = f.restored[0].identity = 'function:unrelated_function()'
    },
    (f) => {
      f.restored[0].rawAcl = '{}'
    },
    (f) => {
      f.restored[0].explicitGrants = '[{"grantee":"fictional-reader"}]'
    },
    (f) => {
      f.source[0].rawAcl = f.source[0].rawAcl.replace('=X/', '=X*/')
    },
    (f) => {
      f.restored[1].rawAcl = '{fictional-reader=r/fictional-owner}'
      f.restored[1].aclIsNull = false
    },
    (f) => {
      f.restored.pop()
    },
    (f) => {
      f.restored.push(structuredClone(f.restored[0]))
    },
    (f) => {
      f.after.existingSecurityHash = f.before.existingSecurityHash
    },
    (f) => {
      f.restored = structuredClone(f.source)
    },
  ]) {
    const f = reviewedPair()
    mutate(f)
    assert.throws(() => assertRelease270RestoreEquivalent(f.before, f.after, f.source, f.restored))
  }
})
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
