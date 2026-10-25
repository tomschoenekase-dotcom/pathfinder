import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const evidenceKinds = [
  'coverage',
  'checkPackage',
  'import',
  'guestLink',
  'embeddings',
  'guidePreview',
  'servingRoute',
  'visitorQa',
  'phoneCheck',
]
const hosted = new Set([
  'import',
  'guestLink',
  'embeddings',
  'servingRoute',
  'visitorQa',
  'phoneCheck',
])
const text = (v) => typeof v === 'string' && v.trim().length > 0
const empty = (v) => Array.isArray(v) && v.length === 0
const instant = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === (v.includes('.') ? v : v.replace('Z', '.000Z'))

// Evidence envelopes are explicit operator attestations wrapping saved tool output.
// This composer validates binding and predicates; it cannot establish the truth of an attestation.
export function composeReceipt(manifestPath, { asOf = new Date().toISOString() } = {}) {
  if (!instant(asOf)) throw new Error('asOf must be a UTC timestamp')
  const base = dirname(resolve(manifestPath))
  const read = (file) => {
    const path = resolve(base, file)
    const bytes = readFileSync(path)
    return { file: path, sha256: sha256(bytes), value: JSON.parse(bytes) }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    manifest.schemaVersion !== 1 ||
    !text(manifest.tenantId) ||
    !text(manifest.venueId) ||
    !text(manifest.package)
  )
    throw new Error('Invalid receipt manifest')
  const pkg = read(manifest.package)
  if (pkg.value.schemaVersion !== 3)
    throw new Error('Only v4-standard schemaVersion 3 packages are accepted')
  const missingItems = []
  const fields = {}
  const reject = (kind, reason) => {
    missingItems.push(`${kind}: ${reason}`)
    fields[kind] = { status: 'NOT_MEASURED', reason }
  }
  for (const kind of evidenceKinds) {
    try {
      const spec = manifest.evidence?.[kind]
      if (!spec || !text(spec.file) || !/^[a-f0-9]{64}$/.test(spec.sha256 ?? ''))
        throw new Error('missing saved evidence file and expected sha256')
      const artifact = read(spec.file)
      if (artifact.sha256 !== spec.sha256) throw new Error('evidence sha256 mismatch')
      const e = artifact.value
      if (
        e.schemaVersion !== 1 ||
        e.kind !== kind ||
        e.tenantId !== manifest.tenantId ||
        e.venueId !== manifest.venueId ||
        e.packageSha256 !== pkg.sha256
      )
        throw new Error('schema, kind, tenant, venue or package binding mismatch')
      if (
        !instant(e.measuredAt) ||
        !instant(e.expiresAt) ||
        Date.parse(e.measuredAt) > Date.parse(asOf) ||
        Date.parse(e.expiresAt) <= Date.parse(asOf) ||
        Date.parse(e.expiresAt) <= Date.parse(e.measuredAt)
      )
        throw new Error('evidence is stale, future-dated or lacks a validity window')
      if (hosted.has(kind) && e.environment !== 'hosted')
        throw new Error('hosted observation required')
      const d = e.data
      if (!d || typeof d !== 'object') throw new Error('missing typed data')
      let ok = false
      switch (kind) {
        case 'coverage': {
          const bindings = [
            d.bindings?.package,
            d.bindings?.ledger,
            d.bindings?.coverage,
            ...(d.bindings?.sources ?? []),
          ]
          if (
            bindings.length < 3 ||
            d.bindings?.package?.sha256 !== pkg.sha256 ||
            !bindings.every(
              (b) => b && text(b.file) && sha256(readFileSync(resolve(base, b.file))) === b.sha256,
            )
          )
            throw new Error('coverage input binding mismatch')
          const checker = new URL('./venue-coverage/check.mjs', import.meta.url).href
          const child = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import {checkCoverage} from ${JSON.stringify(checker)}; const r=await checkCoverage(JSON.parse(process.argv[1])); process.stdout.write(JSON.stringify(r));`,
              JSON.stringify({
                packagePath: pkg.file,
                ledgerPath: resolve(base, d.bindings.ledger.file),
                coveragePath: resolve(base, d.bindings.coverage.file),
                sourcesDir: d.bindings.sources?.length
                  ? dirname(resolve(base, d.bindings.sources[0].file))
                  : resolve(dirname(resolve(base, d.bindings.coverage.file)), 'sources'),
                asOf: asOf.slice(0, 10),
              }),
            ],
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
          )
          if (child.error || child.status !== 0) throw new Error('coverage recomputation failed')
          const recomputed = JSON.parse(child.stdout)
          if (
            !recomputed.passed ||
            JSON.stringify(recomputed.rows) !== JSON.stringify(d.rows) ||
            JSON.stringify(recomputed.bindings) !== JSON.stringify(d.bindings)
          )
            throw new Error('coverage report does not match recomputed inputs')
          ok =
            d.passed === true &&
            d.asOf === asOf.slice(0, 10) &&
            d.verdict === 'PASS' &&
            empty(d.errors) &&
            Array.isArray(d.rows) &&
            d.rows.length > 0 &&
            d.rows.every(
              (r) =>
                ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(r.status) &&
                ['DISCLOSE', 'NONE'].includes(r.publishImpact),
            )
          break
        }
        case 'checkPackage':
          ok =
            d.ready === true &&
            d.importable === true &&
            d.errorCount === 0 &&
            empty(d.errors) &&
            d.guideQuality?.total === 0 &&
            Array.isArray(d.otherWarnings) &&
            !d.otherWarnings.some((w) => w.code === 'DUPLICATE_IN_PACKAGE') &&
            d.venueId === manifest.venueId
          break
        case 'import':
          ok =
            text(d.operationId) &&
            d.status === 'APPLIED' &&
            d.receipt?.status === 'APPLIED' &&
            d.receipt.operationId === d.operationId &&
            d.receipt.packageSha256 === pkg.sha256 &&
            d.receipt.venueId === manifest.venueId &&
            d.receipt.tenantId === manifest.tenantId
          break
        case 'guestLink':
          ok = d.usable === true && text(d.url) && /^https:\/\//.test(d.url)
          break
        case 'embeddings':
          ok =
            d.mode === 'audit' &&
            empty(d.actionableReasons) &&
            Number.isInteger(d.recordsAudited) &&
            d.recordsAudited > 0
          break
        case 'guidePreview':
          ok =
            d.schemaVersion === 1 &&
            d.packageSha256 === pkg.sha256 &&
            d.scope === 'CREATE_ONLY_PACKAGE_PREVIEW' &&
            ['default', 'evidence'].every(
              (s) =>
                ['FULL', 'DIRECTORY'].includes(d[s]?.mode) &&
                Number.isInteger(d[s]?.renderedChars) &&
                d[s].renderedChars > 0 &&
                d[s].maxFullChars === 120000 &&
                d[s].rendererTruncated === false,
            )
          break
        case 'servingRoute':
          ok =
            ['default', 'evidence'].includes(d.guideStrategy) &&
            text(d.modelKey) &&
            text(d.effectiveModelKey) &&
            Object.hasOwn(d, 'workloadOverride') &&
            (d.workloadOverride === null || text(d.workloadOverride)) &&
            Array.isArray(d.venueScopeExceptions) &&
            d.venueScopeExceptions.every(
              (x) => x.venueId === manifest.venueId && text(x.modelKey),
            ) &&
            /^[a-f0-9]{40}$/.test(d.deployedRevision ?? '')
          break
        case 'visitorQa':
          ok =
            d.route === 'guest' &&
            d.routeVerified === true &&
            Number.isInteger(d.turnsCompleted) &&
            d.turnsCompleted > 0 &&
            d.criticalFailures === 0 &&
            Array.isArray(d.results) &&
            d.results.length === d.turnsCompleted &&
            d.results.every(
              (r) =>
                text(r.question) &&
                text(r.answer) &&
                r.completed === true &&
                r.criticalFailure === false &&
                Number.isFinite(r.firstTextMs) &&
                r.firstTextMs >= 0 &&
                Number.isFinite(r.completionMs) &&
                r.completionMs >= r.firstTextMs,
            )
          break
        case 'phoneCheck':
          ok = d.rendered === true && d.passed === true && text(d.viewport) && text(d.checkedBy)
          break
      }
      if (kind === 'servingRoute' && ok) {
        const overrides = d.venueScopeExceptions.map((x) => x.modelKey)
        const effective = overrides.length ? overrides[0] : (d.workloadOverride ?? d.modelKey)
        ok = overrides.length <= 1 && d.effectiveModelKey === effective
      }
      if (!ok) throw new Error('required success predicates not satisfied')
      fields[kind] = {
        status: 'MEASURED',
        file: artifact.file,
        sha256: artifact.sha256,
        timestamp: e.measuredAt,
        expiresAt: e.expiresAt,
      }
    } catch (error) {
      reject(kind, error.message)
    }
  }
  // All hosted observations must describe the same deployment, and follow the import.
  if (fields.import.status === 'MEASURED') {
    const imported = fields.import.timestamp
    for (const kind of hosted)
      if (
        fields[kind].status === 'MEASURED' &&
        Date.parse(fields[kind].timestamp) < Date.parse(imported)
      )
        reject(kind, 'observation predates applied import')
  }
  if (fields.servingRoute.status === 'MEASURED') {
    const revision = read(manifest.evidence.servingRoute.file).value.data.deployedRevision
    for (const kind of hosted)
      if (
        fields[kind].status === 'MEASURED' &&
        read(manifest.evidence[kind].file).value.deployedRevision !== revision
      )
        reject(kind, 'deployed revision mismatch')
  }
  return {
    schemaVersion: 1,
    generatedAt: asOf,
    tenantId: manifest.tenantId,
    venueId: manifest.venueId,
    package: { file: pkg.file, sha256: pkg.sha256 },
    fields,
    verdict: missingItems.length ? 'NOT_READY' : 'PUBLISH_CANDIDATE',
    missingItems,
    note: 'A candidate receipt does not authorize publication or prove attestation authenticity.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (
      args.length % 2 ||
      args.some((v, i) => i % 2 === 0 && !['--manifest', '--output', '--as-of'].includes(v))
    )
      throw new Error('Usage: --manifest file --output file [--as-of UTC-timestamp]')
    const opts = Object.fromEntries(
      Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]),
    )
    if (!opts['--manifest'] || !opts['--output'])
      throw new Error('--manifest and --output are required')
    const result = composeReceipt(opts['--manifest'], { asOf: opts['--as-of'] })
    const output = resolve(opts['--output'])
    const inputs = [
      opts['--manifest'],
      result.package.file,
      ...Object.values(JSON.parse(readFileSync(opts['--manifest'], 'utf8')).evidence ?? {}).map(
        (x) => resolve(dirname(resolve(opts['--manifest'])), x.file),
      ),
    ].map((x) => resolve(x))
    if (inputs.includes(output)) throw new Error('Output must not overwrite an input')
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
    process.exitCode = result.verdict === 'PUBLISH_CANDIDATE' ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
