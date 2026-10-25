import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const MIN_VISITOR_QA_TURNS = 10
// Evidence must be re-measured regularly: hosted observations go stale faster than local reports.
const HOSTED_MAX_WINDOW_MS = 14 * 86_400_000
const LOCAL_MAX_WINDOW_MS = 7 * 86_400_000
// asOf must track the real clock; anything further away is a replay and never a candidate.
const MAX_CLOCK_SKEW_MS = 60 * 60_000
const CORE_COVERAGE_CATEGORIES = ['hours-season', 'admission-prices', 'address-parking', 'contact']
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
// `now` (real clock) and `coverageCheckerUrl` (module exporting checkCoverage) are test seams.
export function composeReceipt(
  manifestPath,
  {
    asOf = new Date().toISOString(),
    now = new Date().toISOString(),
    coverageCheckerUrl = new URL('./venue-coverage/check.mjs', import.meta.url).href,
  } = {},
) {
  if (!instant(asOf)) throw new Error('asOf must be a UTC timestamp')
  if (!instant(now)) throw new Error('now must be a UTC timestamp')
  const base = dirname(resolve(manifestPath))
  // Hash first, parse second; parser messages can echo file contents and are never reported.
  const read = (file, expectedSha256, label = 'evidence file') => {
    const path = resolve(base, file)
    const bytes = readFileSync(path)
    const digest = sha256(bytes)
    if (expectedSha256 !== undefined && digest !== expectedSha256)
      throw new Error('evidence sha256 mismatch')
    try {
      return { file: path, sha256: digest, value: JSON.parse(bytes) }
    } catch {
      throw new Error(`${label} is not valid JSON`)
    }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('manifest is not valid JSON')
  }
  if (
    manifest.schemaVersion !== 1 ||
    !text(manifest.tenantId) ||
    !text(manifest.venueId) ||
    !text(manifest.package)
  )
    throw new Error('Invalid receipt manifest')
  const pkg = read(manifest.package, undefined, 'package file')
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
      const artifact = read(spec.file, spec.sha256)
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
      const maxWindow = hosted.has(kind) ? HOSTED_MAX_WINDOW_MS : LOCAL_MAX_WINDOW_MS
      if (Date.parse(e.expiresAt) - Date.parse(e.measuredAt) > maxWindow)
        throw new Error(
          `evidence validity window exceeds ${maxWindow / 86_400_000} days for ${kind}`,
        )
      if (hosted.has(kind) && e.environment !== 'hosted')
        throw new Error('hosted observation required')
      const d = e.data
      if (!d || typeof d !== 'object') throw new Error('missing typed data')
      let ok = false
      let coverageValidated = false
      let readinessNote
      switch (kind) {
        case 'coverage': {
          if (!text(d.bindings?.sourcesRoot))
            throw new Error('coverage sources root binding missing')
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
          const checker = coverageCheckerUrl
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
                sourcesDir: resolve(base, d.bindings.sourcesRoot),
                asOf: asOf.slice(0, 10),
              }),
            ],
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true },
          )
          if (child.error || child.status !== 0) throw new Error('coverage recomputation failed')
          const recomputed = JSON.parse(child.stdout)
          if (
            !recomputed.passed ||
            JSON.stringify(recomputed.rows) !== JSON.stringify(d.rows) ||
            JSON.stringify(recomputed.bindings) !== JSON.stringify(d.bindings)
          )
            throw new Error('coverage report does not match recomputed inputs')
          if (
            d.passed !== true ||
            d.asOf !== asOf.slice(0, 10) ||
            d.verdict !== 'PASS' ||
            !empty(d.errors)
          )
            throw new Error('coverage report metadata does not match current recomputation')
          coverageValidated = true
          // Readiness uses the RECOMPUTED result, never the saved report's own claims.
          const findings = recomputed.readinessFindings ?? []
          if (!Array.isArray(findings)) readinessNote = 'readinessFindings is malformed'
          else if (findings.length) readinessNote = 'readinessFindings is not empty'
          else if (
            recomputed.rows.some(
              (r) => CORE_COVERAGE_CATEGORIES.includes(r.category) && r.status === 'NOT_APPLICABLE',
            )
          )
            readinessNote = 'a core category (hours, admission, address, contact) is NOT_APPLICABLE'
          ok =
            readinessNote === undefined &&
            Array.isArray(d.rows) &&
            d.rows.length > 0 &&
            d.rows.every(
              (r) =>
                ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(r.status) &&
                ['DISCLOSE', 'NONE'].includes(r.publishImpact) &&
                (r.status !== 'UNKNOWN' || r.publishImpact === 'DISCLOSE'),
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
          if (d.venueId !== manifest.venueId) throw new Error('guest link not bound to venue')
          if (d.environment !== undefined && d.environment !== 'hosted')
            throw new Error('hosted observation required')
          ok = d.usable === true && text(d.url) && /^https:\/\//.test(d.url)
          break
        case 'embeddings':
          ok =
            d.mode === 'audit' &&
            empty(d.actionableReasons) &&
            Number.isInteger(d.recordsAudited) &&
            d.recordsAudited > 0
          if (
            ok &&
            d.recordsAudited <
              (pkg.value.knowledgeEntries?.create?.length ?? 0) +
                (pkg.value.places?.create?.length ?? 0)
          )
            throw new Error('recordsAudited is below the package created knowledge plus places')
          break
        case 'guidePreview': {
          if (d.asOf !== asOf.slice(0, 10))
            throw new Error('guide preview must match the current as-of day')
          const child = spawnSync(
            process.execPath,
            [
              fileURLToPath(new URL('./venue-guide-preview.mjs', import.meta.url)),
              '--package',
              pkg.file,
              '--as-of',
              asOf.slice(0, 10),
            ],
            { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 40_000, windowsHide: true },
          )
          if (child.error || child.status !== 0)
            throw new Error('guide preview recomputation failed')
          const recomputed = JSON.parse(child.stdout)
          if (!isDeepStrictEqual(d, recomputed))
            throw new Error('guide preview does not match native recomputation')
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
        }
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
            d.turnsCompleted >= MIN_VISITOR_QA_TURNS &&
            d.criticalFailures === 0 &&
            // The grading of this question set cannot be verified here; only its identity is recorded.
            d.questionSet !== null &&
            typeof d.questionSet === 'object' &&
            text(d.questionSet.file) &&
            /^[a-f0-9]{64}$/.test(d.questionSet.sha256 ?? '') &&
            Array.isArray(d.results) &&
            d.results.length === d.turnsCompleted &&
            new Set(d.results.map((r) => String(r.question).trim().toLowerCase())).size ===
              d.results.length &&
            d.results.every(
              (r) =>
                text(r.question) &&
                text(r.answer) &&
                r.completed === true &&
                r.criticalFailure === false &&
                Number.isFinite(r.firstTextMs) &&
                r.firstTextMs > 0 &&
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
      if (!ok && !coverageValidated) throw new Error('required success predicates not satisfied')
      fields[kind] = {
        status: 'MEASURED',
        file: artifact.file,
        sha256: artifact.sha256,
        timestamp: e.measuredAt,
        expiresAt: e.expiresAt,
        readinessPassed: ok,
      }
      if (!ok) {
        const failureReason = `required success predicates not satisfied: ${
          readinessNote ??
          'coverage contains publication blockers, unresolved human decisions or undisclosed unknowns'
        }`
        fields[kind].failureReason = failureReason
        missingItems.push(`${kind}: ${failureReason}`)
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
    let revision
    try {
      revision = read(manifest.evidence.servingRoute.file, fields.servingRoute.sha256).value.data
        .deployedRevision
    } catch (error) {
      reject('servingRoute', error.message)
    }
    for (const kind of hosted)
      if (revision !== undefined && fields[kind].status === 'MEASURED') {
        try {
          if (
            read(manifest.evidence[kind].file, fields[kind].sha256).value.deployedRevision !==
            revision
          )
            reject(kind, 'deployed revision mismatch')
        } catch (error) {
          reject(kind, error.message)
        }
      }
  }
  if (Math.abs(Date.parse(asOf) - Date.parse(now)) > MAX_CLOCK_SKEW_MS)
    missingItems.push('asOf: historical or future replay cannot produce a publish candidate')
  return {
    schemaVersion: 1,
    generatedAt: asOf,
    composedAt: now,
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
    const result = composeReceipt(opts['--manifest'], {
      asOf: opts['--as-of'],
    })
    const output = resolve(opts['--output'])
    const inputs = [
      opts['--manifest'],
      result.package.file,
      ...Object.values(JSON.parse(readFileSync(opts['--manifest'], 'utf8')).evidence ?? {}).map(
        (x) => resolve(dirname(resolve(opts['--manifest'])), x.file),
      ),
    ].map((x) => resolve(x))
    if (inputs.includes(output)) throw new Error('Output must not overwrite an input')
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
      flag: 'wx',
    })
    process.exitCode = result.verdict === 'PUBLISH_CANDIDATE' ? 0 : 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
