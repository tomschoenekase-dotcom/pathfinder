const AFFECTED_MIGRATIONS = [
  '20260811235945_add_structured_bootstrap_source_kind',
  '20260811235950_add_onboarding_bootstrap_intake',
  '20260811235955_add_file_upload_source_kind',
  '20260811235960_add_quarantined_intake_upload',
  '20260812001150_add_precheck_passed_upload_status',
  '20260812001200_add_intake_upload_verification_receipts',
  '20260812001400_add_native_venue_deployments',
  '20260812001500_add_native_deployment_evaluation_evidence',
  '20260812001550_add_universal_item_kind',
  '20260812001600_add_universal_item_content',
]

function state(row) {
  if (row.rolled_back_at !== null && row.rolled_back_at !== undefined) return 'rolled-back'
  if (row.finished_at === null || row.finished_at === undefined) return 'failed-or-running'
  return 'finished'
}

export function reconcileAffectedMigrationLedger({ rows, expectedChecksums }) {
  if (!Array.isArray(rows) || typeof expectedChecksums !== 'object' || expectedChecksums === null) {
    throw new Error('invalid-ledger-evidence')
  }

  const byName = new Map()
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      typeof row.migration_name !== 'string' ||
      typeof row.checksum !== 'string'
    ) {
      throw new Error('invalid-ledger-row')
    }
    if (byName.has(row.migration_name)) throw new Error('duplicate-ledger-migration')
    byName.set(row.migration_name, row)
  }

  const findings = []
  for (const migration of AFFECTED_MIGRATIONS) {
    const row = byName.get(migration)
    if (!row) {
      findings.push({ migration, state: 'missing', checksum: 'not-compared' })
      continue
    }
    const rowState = state(row)
    const expected = expectedChecksums[migration]
    findings.push({
      migration,
      state: rowState,
      checksum:
        typeof expected === 'string' && row.checksum.toLowerCase() === expected.toLowerCase()
          ? 'match'
          : 'mismatch',
    })
  }

  const predecessors = AFFECTED_MIGRATIONS.filter((name) =>
    /235945|235955|12001150|12001550/u.test(name),
  )
  const successors = AFFECTED_MIGRATIONS.filter((name) => !predecessors.includes(name))
  const unsafe =
    findings.some(
      (finding) =>
        finding.state === 'failed-or-running' ||
        (finding.state === 'finished' && finding.checksum !== 'match'),
    ) ||
    (predecessors.some((name) => !byName.has(name)) &&
      successors.some((name) => state(byName.get(name) ?? {}) === 'finished'))

  return {
    decision: unsafe
      ? 'stop'
      : findings.every((finding) => finding.state === 'missing')
        ? 'clean'
        : 'review',
    findings,
  }
}

export { AFFECTED_MIGRATIONS }
