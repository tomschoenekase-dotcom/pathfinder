// Disposable logical restore comparison only. Operational cutoff checks stay exact.
import assert from 'node:assert/strict'
import { logicalEnumRows, logicalConstraintDefinition } from './release269-logical-schema.mjs'

// DIAGNOSTICS ONLY. Preserve raw ACL (including NULL versus empty), object kind,
// owner and explicit grants. Effective-default expansion is NOT admitted here:
// a hash difference must first be explained from actual fictional source rows.
// Index/row-type privileges cannot be treated as table privileges by default.
export const RESTORE_SECURITY_SQL = `WITH objects AS (
 SELECT 'relation:'||c.relname AS identity, c.relowner AS owner, c.relkind::text AS kind,
 c.relacl AS acl,
 CASE WHEN c.relkind='S' THEN 's' WHEN c.relkind IN ('r','p','v','m','f') THEN 'r' ELSE NULL END AS default_kind
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'function:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',p.proowner,
 'function',p.proacl,'f' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 UNION ALL SELECT 'schema:public',nspowner,'schema',nspacl,'n' FROM pg_namespace WHERE nspname='public'
 UNION ALL SELECT 'type:'||t.typname,t.typowner,'type:'||t.typtype::text,t.typacl,'T' FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'defaults:'||pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'global')||':'||d.defaclobjtype::text,d.defaclrole,'default:'||d.defaclobjtype::text,d.defaclacl,NULL
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public' OR d.defaclnamespace=0
 UNION ALL SELECT 'column:'||c.relname||'.'||a.attname,c.relowner,'column',a.attacl,NULL
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
 ) SELECT identity,pg_get_userbyid(owner) AS owner,kind,acl::text AS "rawAcl",acl IS NULL AS "aclIsNull",default_kind AS "defaultKind",
 coalesce((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) FROM aclexplode(acl) a),'[]'::jsonb)::text AS "explicitGrants",
 CASE WHEN default_kind IS NULL THEN NULL ELSE
 (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(acl,acldefault(default_kind::"char",owner))) a) END AS "diagnosticEffectiveGrants"
 FROM objects ORDER BY identity`

const logicalCatalog = (catalog) => ({
  ...catalog,
  enums: logicalEnumRows(catalog.enums),
  constraints: catalog.constraints.map((row) => ({
    ...row,
    definition: logicalConstraintDefinition(row.definition),
  })),
})

// Reviewed from both PG16/PG17 fictional source/restore diagnostics at96d48b0:
// pg_dump omits this one function's explicit built-in-default EXECUTE ACL.
// This is deliberately not an all-functions/all-objects effective-ACL rule.
const restoredFunction =
  'function:pathfinder_guest_disposition_row_blocked(table_name text, row_value jsonb)'
const executor = 'pathfinder_guest_disposition_executor'
const explicitDefaultAcl = `{${executor}=X/${executor},=X/${executor}}`
const defaultGrants = [
  { grantee: 'PUBLIC', grantor: executor, grantable: false, privilege: 'EXECUTE' },
  { grantee: executor, grantor: executor, grantable: false, privilege: 'EXECUTE' },
]
function reviewedFunctionAcl(row) {
  if (row.identity !== restoredFunction) return null
  if (row.owner !== executor || row.kind !== 'function' || row.defaultKind !== 'f') return null
  // Never accept a changed grantor, grant option, grantee, privilege or ordering.
  if (
    !row.diagnosticEffectiveGrants ||
    JSON.stringify(row.diagnosticEffectiveGrants) !== JSON.stringify(defaultGrants)
  )
    return null
  if (row.rawAcl === null && row.aclIsNull === true && row.explicitGrants === '[]')
    return 'null-default'
  if (row.rawAcl !== explicitDefaultAcl || row.aclIsNull !== false) return null
  try {
    assert.deepEqual(JSON.parse(row.explicitGrants), defaultGrants)
    return 'explicit-default'
  } catch {
    return null
  }
}

function assertRestoreSecurity(source, restored, rawHashChanged) {
  assert.ok(
    Array.isArray(source) && source.length > 0 && Array.isArray(restored),
    'restore security receipt required',
  )
  for (const rows of [source, restored])
    assert.equal(
      new Set(rows.map((row) => row.identity)).size,
      rows.length,
      'restore duplicate security identity',
    )
  assert.equal(source.length, restored.length, 'restore security coverage changed')
  let normalizedDifferences = 0
  const normalizedSource = source.map((row, index) => {
    const other = restored[index]
    if (JSON.stringify(row) === JSON.stringify(other)) return row
    const left = reviewedFunctionAcl(row),
      right = reviewedFunctionAcl(other)
    if (!left || !right || left === right) return row
    // Normalize only these three representation fields. Every other object row
    // and field must still match byte-for-byte via the full comparison below.
    normalizedDifferences++
    return {
      ...row,
      rawAcl: other.rawAcl,
      aclIsNull: other.aclIsNull,
      explicitGrants: other.explicitGrants,
    }
  })
  assert.deepEqual(restored, normalizedSource, 'restore effective security changed')
  assert.ok(normalizedDifferences <= 1, 'restore security normalization exceeded')
  assert.equal(
    rawHashChanged,
    normalizedDifferences === 1,
    'restore raw security difference requires independent review',
  )
  return normalizedDifferences
}

export function assertRelease270RestoreEquivalent(
  before,
  restored,
  sourceSecurity,
  restoredSecurity,
) {
  const comparable = ({ observedAt, catalog, existingSecurityHash, ...snapshot }) => snapshot
  assert.deepEqual(
    comparable(restored),
    comparable(before),
    'restore retained data/ledger/queues/state changed',
  )
  assert.deepEqual(
    logicalCatalog(restored.catalog),
    logicalCatalog(before.catalog),
    'restore logical catalog changed',
  )
  const rawSecurityChanged = before.existingSecurityHash !== restored.existingSecurityHash
  const normalizedSecurityDifferences = assertRestoreSecurity(
    sourceSecurity,
    restoredSecurity,
    rawSecurityChanged,
  )
  return {
    scope: 'logical-disposable-restore-only',
    rawCatalogChanged: JSON.stringify(before.catalog) !== JSON.stringify(restored.catalog),
    rawSecurityChanged,
    normalizedSecurityDifferences,
  }
}
