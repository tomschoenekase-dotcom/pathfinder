import { open, readFile } from 'node:fs/promises'
import { resolve, join, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMigrationManifest, ledgerState } from '../run-staging-migration-predeploy.mjs'
import {
  canonicalDispositionJson,
  dispositionSha256,
  readDispositionJournal,
  appendDispositionJournal,
} from './guest-conversation-disposition-journal.mjs'
import { resolveGuestConversationDispositionPolicy } from '../../packages/config/src/guest-conversation-disposition-policy.runtime.mjs'

const hash = /^[a-f0-9]{64}$/u
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/u
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const refuse = (message) => {
  throw new Error(`GUEST_DISPOSITION_MAINTENANCE_REFUSED: ${message}`)
}
export const dispositionSqlLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'"
const literal = dispositionSqlLiteral
const inside = (parent, path) => {
  const part = relative(resolve(parent), resolve(path))
  return part === '' || (!part.startsWith('..') && !isAbsolute(part))
}
const identifier = (value) => '"' + value.replaceAll('"', '""') + '"'

export async function retainDispositionMetadata(path, value) {
  const bytes = Buffer.from(canonicalDispositionJson(value) + '\n')
  if (bytes.length > 4 * 1024 * 1024) refuse('receipt size')
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  if (!(await readFile(path)).equals(bytes)) refuse('receipt readback')
  return { path: resolve(path), sha256: dispositionSha256(bytes), bytes: bytes.length }
}

/** All values are metadata. These are explicit operator evidence bindings, not
 * machine claims that outside processes/holds/custody were independently found.
 * The operator supplies a new current scoped reconfirmation on every recovery.
 */
export async function validateDispositionMaintenancePlan(plan, now = Date.now()) {
  const keys = [
    'version',
    'mode',
    'target',
    'journalPath',
    'expectedHeadSha256',
    'operationId',
    'requestSha256',
    'operator',
    'evidence',
    'sourceBindings',
    'recoverClosedAdmission',
    'reopenAfterReconciliation',
  ]
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !== keys.sort().join(',') ||
    plan.version !== 'guest-disposition-maintenance-v1' ||
    !['APPLY', 'RECONCILE'].includes(plan.mode) ||
    typeof plan.recoverClosedAdmission !== 'boolean' ||
    typeof plan.reopenAfterReconciliation !== 'boolean'
  )
    refuse('plan shape')
  if (
    !hash.test(plan.expectedHeadSha256 ?? '') ||
    typeof plan.journalPath !== 'string' ||
    !plan.journalPath
  )
    refuse('external journal binding')
  const target = plan.target
  if (
    !target ||
    Object.keys(target).sort().join(',') !==
      'database,databaseOid,postmasterStartedAt,role,systemIdentifier' ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(target.database) ||
    ['postgres', 'template0', 'template1'].includes(target.database) ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(target.role) ||
    !/^\d+$/u.test(target.databaseOid) ||
    !/^\d+$/u.test(target.systemIdentifier) ||
    !Number.isFinite(Date.parse(target.postmasterStartedAt))
  )
    refuse('target identity')
  if (
    plan.mode === 'APPLY'
      ? !uuid.test(plan.operationId ?? '') || !hash.test(plan.requestSha256 ?? '')
      : plan.operationId !== null || plan.requestSha256 !== null
  )
    refuse('operation selector')
  const operator = plan.operator
  if (
    !operator ||
    Object.keys(operator).sort().join(',') !== 'actorId,confirmedAt,holdAssessments' ||
    !id.test(operator.actorId ?? '') ||
    !Number.isFinite(Date.parse(operator.confirmedAt)) ||
    now - Date.parse(operator.confirmedAt) > 300000 ||
    Date.parse(operator.confirmedAt) - now > 5000 ||
    !Array.isArray(operator.holdAssessments) ||
    operator.holdAssessments.length > 10000
  )
    refuse('current operator reconfirmation')
  const seen = new Set()
  for (const entry of operator.holdAssessments) {
    if (
      !entry ||
      Object.keys(entry).sort().join(',') !== 'operationId,referenceSha256,status' ||
      !uuid.test(entry.operationId ?? '') ||
      !hash.test(entry.referenceSha256 ?? '') ||
      entry.status !== 'NO_KNOWN_HOLD' ||
      seen.has(entry.operationId)
    )
      refuse('scoped hold reconfirmation')
    seen.add(entry.operationId)
  }
  if (
    !plan.evidence ||
    Object.keys(plan.evidence).sort().join(',') !== 'journalCustody,servicesStopped' ||
    !Array.isArray(plan.sourceBindings) ||
    plan.sourceBindings.length < 1 ||
    plan.sourceBindings.length > 512
  )
    refuse('evidence bindings')
  for (const binding of [...Object.values(plan.evidence), ...plan.sourceBindings]) {
    if (
      !binding ||
      Object.keys(binding).sort().join(',') !== 'path,sha256' ||
      !hash.test(binding.sha256 ?? '') ||
      typeof binding.path !== 'string'
    )
      refuse('file binding')
    const raw = await readFile(binding.path)
    if (raw.length > 64 * 1024 * 1024 || dispositionSha256(raw) !== binding.sha256)
      refuse('file hash drift')
  }
  const parseEvidence = async (binding) => {
    const raw = await readFile(binding.path)
    if (raw.length > 65536) refuse('external evidence bound')
    return JSON.parse(raw)
  }
  const stopped = await parseEvidence(plan.evidence.servicesStopped)
  if (
    Object.keys(stopped).sort().join(',') !==
      'actorId,allWritersStopped,automaticRestartsPaused,inMemoryCopiesRetired,observedUtc,outstandingProviderWorkSettled,target,version' ||
    stopped.version !== 'guest-disposition-stopped-services-v1' ||
    stopped.actorId !== operator.actorId ||
    canonicalDispositionJson(stopped.target) !== canonicalDispositionJson(target) ||
    [
      'allWritersStopped',
      'automaticRestartsPaused',
      'inMemoryCopiesRetired',
      'outstandingProviderWorkSettled',
    ].some((key) => stopped[key] !== true) ||
    !Number.isFinite(Date.parse(stopped.observedUtc)) ||
    now - Date.parse(stopped.observedUtc) > 300000 ||
    Date.parse(stopped.observedUtc) - now > 5000
  )
    refuse('current external stopped-services evidence')
  const custody = await parseEvidence(plan.evidence.journalCustody)
  if (
    Object.keys(custody).sort().join(',') !==
      'actorId,custodyReferenceSha256,highWaterSha256,journalPath,observedUtc,protectedRestoreRoots,version' ||
    custody.version !== 'guest-disposition-journal-custody-v1' ||
    custody.actorId !== operator.actorId ||
    custody.highWaterSha256 !== plan.expectedHeadSha256 ||
    custody.journalPath !== resolve(plan.journalPath) ||
    !isAbsolute(plan.journalPath) ||
    !hash.test(custody.custodyReferenceSha256 ?? '') ||
    !Array.isArray(custody.protectedRestoreRoots) ||
    custody.protectedRestoreRoots.length < 1 ||
    custody.protectedRestoreRoots.length > 32 ||
    custody.protectedRestoreRoots.some(
      (path) => typeof path !== 'string' || !isAbsolute(path) || inside(path, plan.journalPath),
    ) ||
    !Number.isFinite(Date.parse(custody.observedUtc)) ||
    now - Date.parse(custody.observedUtc) > 300000 ||
    Date.parse(custody.observedUtc) - now > 5000
  )
    refuse('external current high-water/custody/location evidence')
  // Required local sources cannot be replaced by a caller-selected unrelated file.
  const mandatory = [
    'scripts/lib/guest-conversation-disposition-maintenance.mjs',
    'scripts/lib/guest-conversation-disposition-journal.mjs',
    'scripts/lib/guest-conversation-disposition-psql.mjs',
    'scripts/guest-conversation-disposition-maintenance.mjs',
    'scripts/run-staging-migration-predeploy.mjs',
    'packages/contracts/src/guest-conversation-disposition.ts',
    'packages/contracts/src/guest-conversation-disposition.runtime.mjs',
    'packages/config/src/guest-conversation-disposition-policy.ts',
    'packages/config/src/guest-conversation-disposition-policy.runtime.mjs',
    'packages/db/prisma/migrations/20260912080000_add_guest_conversation_disposition/migration.sql',
  ]
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const paths = new Set(plan.sourceBindings.map((binding) => resolve(binding.path)))
  if (mandatory.some((path) => !paths.has(resolve(root, path))))
    refuse('required source binding absent')
  const manifest = await readMigrationManifest(resolve(root, 'packages/db/prisma'))
  if (
    manifest.names.length !== 251 ||
    manifest.names[248] !== '20260912080000_add_guest_conversation_disposition' ||
    manifest.names[249] !== '20260918190000_add_agent_routines' ||
    manifest.names[250] !== '20260925044500_add_prospect_outreach_draft_gmail_links' ||
    manifest.names.at(-1) !== '20260925044500_add_prospect_outreach_draft_gmail_links'
  )
    refuse('source migration endpoint')
  if (
    manifest.names.some(
      (name) => !paths.has(resolve(root, 'packages/db/prisma/migrations', name, 'migration.sql')),
    )
  )
    refuse('complete migration source bindings required')
  return plan
}

function checkAuthority(intent, plan) {
  if (!resolveGuestConversationDispositionPolicy(intent.policyVersion, intent.policySha256))
    refuse('policy no longer supported')
  const assessment = plan.operator.holdAssessments.find(
    (entry) => entry.operationId === intent.operationId,
  )
  if (
    intent.authority.actorId !== plan.operator.actorId ||
    !assessment ||
    intent.authority.holdAssessment.referenceSha256 !== assessment.referenceSha256
  )
    refuse('current scoped actor/hold mismatch')
}
function compareReceipt(receipt, intent, intentHash) {
  const expected = Object.fromEntries(
    [
      'operationId',
      'tenantId',
      'venueId',
      'sessionId',
      'requestSha256',
      'policyVersion',
      'policySha256',
      'effectiveCutoffUtc',
      'affected',
    ].map((key) => [key, intent[key]]),
  )
  expected.version = 'guest-disposition-db-receipt-v1'
  expected.externalIntentSha256 = intentHash
  if (canonicalDispositionJson(receipt) !== canonicalDispositionJson(expected))
    refuse('database receipt differs from sealed intent')
}
const identitySql = `SELECT jsonb_build_object('database',current_database(),'role',session_user,'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'postmasterStartedAt',to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))`

export async function verifyDispositionDatabaseSource(target) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const manifest = await readMigrationManifest(resolve(root, 'packages/db/prisma'))
  const rows = await target.query(
    `SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT migration_name,checksum,finished_at,rolled_back_at,logs FROM public._prisma_migrations ORDER BY migration_name LIMIT 251) x`,
  )
  if (!Array.isArray(rows) || rows.length !== 251) refuse('database migration endpoint')
  if (ledgerState(rows, manifest) !== 'complete') refuse('current ledger')
  const final = rows[248],
    name = manifest.names[248]
  if (
    final.migration_name !== name ||
    final.finished_at === null ||
    final.rolled_back_at !== null ||
    (typeof final.logs === 'string' && final.logs.trim() !== '') ||
    ![
      manifest.checksums.get(name),
      manifest.ledgerChecksums.get(name),
      manifest.crlfLedgerChecksums.get(name),
    ].includes(final.checksum)
  )
    refuse('disposition migration checksum/status')
  const sql = await readFile(
    resolve(root, 'packages/db/prisma/migrations', name, 'migration.sql'),
    'utf8',
  )
  const expected = new Map()
  for (const match of sql.matchAll(
    /CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(pathfinder_[a-z_]+)\([^]*?\bAS \$\$([^]*?)\$\$;/gu,
  )) {
    const body = match[2],
      lf = body.replaceAll('\r\n', '\n')
    expected.set(
      match[1],
      new Set([
        dispositionSha256(body),
        dispositionSha256(lf),
        dispositionSha256(lf.replaceAll('\n', '\r\n')),
      ]),
    )
  }
  if (expected.size < 10) refuse('source function body extraction')
  const functions = await target.query(
    `SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT p.proname AS name,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS sha256 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (${[...expected.keys()].map(literal).join(',')}) ORDER BY p.proname) x`,
  )
  if (
    !Array.isArray(functions) ||
    functions.length !== expected.size ||
    functions.some((entry) => !expected.get(entry.name)?.has(entry.sha256))
  )
    refuse('executed function body drift')
  const integrity = await target.query(
    `SELECT jsonb_build_object('tables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT c.convalidated))`,
  )
  if (
    integrity.tables !== 268 ||
    integrity.invalidIndexes !== 0 ||
    integrity.unvalidatedConstraints !== 0
  )
    refuse('schema integrity')
}

/** Sessions expose query(sql): one bounded JSON result only, resolved after psql
 * reaches its post-command marker (including autocommit). The same engine is used
 * for ordinary application and every external intent on restoration.
 */
export async function runDispositionMaintenance({
  plan,
  control,
  connectTarget,
  outputDirectory,
  now = () => Date.now(),
}) {
  let journal
  try {
    await validateDispositionMaintenancePlan(plan, now())
    journal = await readDispositionJournal(plan.journalPath, plan.expectedHeadSha256)
    const selected = plan.mode === 'APPLY' ? journal.intents.get(plan.operationId) : null
    if (selected && selected.payload.requestSha256 !== plan.requestSha256)
      refuse('selected existing intent request hash mismatch')
  } catch (error) {
    await control.close()
    throw error
  }
  let target
  let admission = 'UNKNOWN'
  let reopened = false
  let step = 'IDENTITY'
  let sequence = 0
  const results = []
  let pending = null
  const retain = (kind, value) =>
    retainDispositionMetadata(
      join(outputDirectory, `${String(++sequence).padStart(3, '0')}-${kind}.json`),
      value,
    )
  const targetName = identifier(plan.target.database)
  const close = async () => {
    admission = 'UNKNOWN'
    const state = await control.query(
      `ALTER DATABASE ${targetName} ALLOW_CONNECTIONS false; SELECT jsonb_build_object('closed',NOT datallowconn) FROM pg_database WHERE datname=${literal(plan.target.database)}`,
    )
    if (state.closed !== true) refuse('admission closure readback')
    admission = 'CLOSED'
  }
  const checkTarget = async () => {
    const identity = await target.query(identitySql)
    if (canonicalDispositionJson(identity) !== canonicalDispositionJson(plan.target))
      refuse('target identity drift')
    await target.query(
      `SELECT jsonb_build_object('checked',true) FROM public.pathfinder_guest_disposition_maintenance_check()`,
    )
  }
  const coverage = async (allowedMissing = null) => {
    const operations = await target.query(
      `SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT id::text AS "operationId",request_sha256 AS "requestSha256",state::text AS state,external_intent_sha256 AS "externalIntentSha256" FROM public.guest_conversation_disposition_operations WHERE state IN ('FENCED','APPLIED') ORDER BY id LIMIT 10001) x`,
    )
    if (!Array.isArray(operations) || operations.length > 10000) refuse('operation coverage cap')
    for (const operation of operations) {
      const entry = journal.intents.get(operation.operationId)
      if (!entry && operation.operationId === allowedMissing && operation.state === 'FENCED')
        continue
      if (
        !entry ||
        entry.payload.requestSha256 !== operation.requestSha256 ||
        (operation.externalIntentSha256 !== null &&
          operation.externalIntentSha256 !== entry.payloadSha256)
      )
        refuse('database fenced operation missing/conflicting in complete external journal')
    }
  }
  try {
    // Control query never connects to the target. No database name is inferred.
    const controlState = await control.query(
      `SELECT jsonb_build_object('database',current_database(),'role',session_user,'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'postmasterStartedAt',to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'targetOid',(SELECT oid::text FROM pg_database WHERE datname=${literal(plan.target.database)}),'allowsConnections',(SELECT datallowconn FROM pg_database WHERE datname=${literal(plan.target.database)}))`,
    )
    if (
      controlState.database !== 'postgres' ||
      controlState.role !== plan.target.role ||
      controlState.systemIdentifier !== plan.target.systemIdentifier ||
      controlState.postmasterStartedAt !== plan.target.postmasterStartedAt ||
      controlState.targetOid !== plan.target.databaseOid
    )
      refuse('control identity mismatch')
    admission =
      controlState.allowsConnections === false
        ? 'CLOSED'
        : controlState.allowsConnections === true
          ? 'OPEN'
          : 'UNKNOWN'
    await retain('start', {
      version: 1,
      planSha256: dispositionSha256(plan),
      target: plan.target,
      externalHeadSha256: journal.headSha256,
      observedUtc: new Date(now()).toISOString(),
      scope:
        'operator-evidence-bound maintenance; no independent live custody/hold/process discovery',
    })
    if (controlState.allowsConnections === false) {
      if (!plan.recoverClosedAdmission)
        refuse('closed admission requires explicit recovery handshake')
      await retain('recovery-window', {
        temporarilyOpeningForSoleMaintenanceConnection: true,
        externalServicesMustRemainStopped: true,
      })
      step = 'RECOVERY_OPEN'
      admission = 'UNKNOWN'
      const opened = await control.query(
        `ALTER DATABASE ${targetName} ALLOW_CONNECTIONS true; SELECT jsonb_build_object('allowsConnections',datallowconn) FROM pg_database WHERE datname=${literal(plan.target.database)}`,
      )
      if (opened.allowsConnections !== true) refuse('recovery opening readback unknown')
      admission = 'OPEN'
    } else if (controlState.allowsConnections !== true) refuse('target admission unknown')
    try {
      target = await connectTarget()
    } finally {
      await close()
    }
    await checkTarget()
    const location = await target.query(
      `SELECT jsonb_build_object('dataDirectory',current_setting('data_directory'))`,
    )
    if (
      typeof location.dataDirectory !== 'string' ||
      inside(location.dataDirectory, plan.journalPath)
    )
      refuse('journal inside actual database directory')
    await verifyDispositionDatabaseSource(target)
    await coverage(plan.mode === 'APPLY' ? plan.operationId : null)
    step = 'RECONCILE'
    for (const entry of journal.intents.values()) {
      await validateDispositionMaintenancePlan(plan, now())
      checkAuthority(entry.payload, plan)
      const resolution = await target.query(
        `SELECT public.pathfinder_restore_guest_disposition(${literal(canonicalDispositionJson(entry.payload))}::jsonb,${literal(entry.payloadSha256)})`,
      )
      if (
        resolution.resolution === 'APPLIED_POSTCONDITIONS_VERIFIED' &&
        resolution.currentSessionPresent === true
      ) {
        compareReceipt(resolution.receipt, entry.payload, entry.payloadSha256)
        pending = { receipt: resolution.receipt, intentHash: entry.payloadSha256 }
        journal = await appendDispositionJournal(
          plan.journalPath,
          journal.headSha256,
          'COMPLETION',
          resolution.receipt,
        )
        pending = null
      } else if (
        resolution.resolution === 'TOMBSTONE_ONLY' &&
        resolution.currentSessionPresent === false &&
        resolution.operationId === entry.payload.operationId &&
        resolution.externalIntentSha256 === entry.payloadSha256 &&
        ['tenantId', 'venueId', 'sessionId', 'requestSha256'].every(
          (key) => resolution[key] === entry.payload[key],
        )
      ) {
        // This is an external restore resolution, never a fabricated DB completion.
      } else refuse('unrecognized restore resolution')
      results.push(await retain('reconciled', { resolution, headSha256: journal.headSha256 }))
    }
    if (plan.mode === 'APPLY' && !journal.intents.has(plan.operationId)) {
      step = 'SEAL'
      await validateDispositionMaintenancePlan(plan, now())
      const intent = await target.query(
        `SELECT public.pathfinder_seal_guest_disposition(${literal(plan.operationId)}::uuid,${literal(plan.requestSha256)})`,
      )
      checkAuthority(intent, plan)
      // This durable metadata binding records the present operator reconfirmation
      // against the exact immutable intent before any erasure invocation.
      await retain('intent-execution', {
        intentSha256: dispositionSha256(intent),
        planSha256: dispositionSha256(plan),
        operator: plan.operator,
        target: plan.target,
      })
      step = 'JOURNAL_INTENT'
      journal = await appendDispositionJournal(
        plan.journalPath,
        journal.headSha256,
        'INTENT',
        intent,
      )
      await retain('intent-durable', {
        headSha256: journal.headSha256,
        intentSha256: dispositionSha256(intent),
      })
      step = 'APPLY'
      await validateDispositionMaintenancePlan(plan, now())
      const receipt = await target.query(
        `SELECT public.pathfinder_apply_guest_disposition(${literal(plan.operationId)}::uuid,${literal(plan.requestSha256)},${literal(dispositionSha256(intent))})`,
      )
      compareReceipt(receipt, intent, dispositionSha256(intent))
      pending = { receipt, intentHash: dispositionSha256(intent) }
      step = 'JOURNAL_COMPLETION'
      journal = await appendDispositionJournal(
        plan.journalPath,
        journal.headSha256,
        'COMPLETION',
        receipt,
      )
      pending = null
      results.push(await retain('applied', { receipt, headSha256: journal.headSha256 }))
    }
    // Prove all present tombstones are represented, and verify every applied row
    // again in the same closed-admission connection before optional reopening.
    step = 'FINAL_RECONCILIATION'
    await readDispositionJournal(plan.journalPath, journal.headSha256)
    await coverage()
    await checkTarget()
    const ready = await retain('reconciliation-complete', {
      headSha256: journal.headSha256,
      intents: journal.intents.size,
      results,
      target: plan.target,
      admissionClosed: true,
    })
    if (plan.reopenAfterReconciliation) {
      await validateDispositionMaintenancePlan(plan, now())
      await checkTarget()
      step = 'REOPEN'
      // Sending ALTER may commit even if its acknowledgement is lost.
      admission = 'UNKNOWN'
      const opened = await control.query(
        `ALTER DATABASE ${targetName} ALLOW_CONNECTIONS true; SELECT jsonb_build_object('allowsConnections',datallowconn) FROM pg_database WHERE datname=${literal(plan.target.database)}`,
      )
      if (opened.allowsConnections !== true) refuse('reopening readback unknown')
      reopened = true
      admission = 'OPEN'
    }
    return { status: 'RECONCILED', reopened, headSha256: journal.headSha256, ready }
  } catch (error) {
    // No attempt to infer whether a timed-out apply committed, no retry, no open.
    const result = {
      status: pending ? 'DB_COMMITTED_EXTERNAL_COMPLETION_PENDING' : 'RECONCILIATION_REQUIRED',
      step,
      databaseAdmission: admission,
      databaseState: pending ? 'COMMITTED' : 'UNKNOWN',
      headSha256: journal.headSha256,
      pendingReceipt: pending?.receipt ?? null,
      nextAction: 'RECONCILE_SAME_OPERATION',
      failureCode:
        typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(error.code)
          ? error.code
          : 'OPERATOR_STEP_REFUSED',
    }
    await retain('failure', result)
    return result
  } finally {
    await target?.close()
    await control.close()
  }
}
