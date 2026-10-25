import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const checks = ['sourceIntegrity', 'coverage', 'guidePreview', 'acceptance']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const key = (p) => path.resolve(p).toLowerCase()
const inside = (base, target) => {
  const relative = path.relative(key(base), key(target))
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..')
}
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const segment = (v) =>
  typeof v === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)
const timestamp = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v.replace(/(?<!\.\d{3})Z$/, '.000Z')
const prohibited =
  /^(questions\.json|expected-facts\.json|(?:gold|holdout)(?:[ ._-].*)?|credentials?(?:\..*)?|tokens?(?:\..*)?|browser[ -]?profiles?|\.env(?:\..*)?|\.npmrc|login data|local state|cookies)$/i
const suppliedKinds = new Set([
  'checkPackage',
  'import',
  'guestLink',
  'embeddings',
  'servingRoute',
  'visitorQa',
  'phoneCheck',
])

function relativeName(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    /[:\x00-\x1f]/.test(value) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    value
      .split(/[\\/]/)
      .some(
        (p) =>
          !p ||
          p === '..' ||
          p === '.' ||
          prohibited.test(p) ||
          /[<>"|?*]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new Error('Input paths must be bounded relative packet paths')
  return value
}

async function bounded(base, name, directory = false) {
  const candidate = path.resolve(base, relativeName(name))
  const actual = await realpath(candidate)
  if (!inside(base, actual)) throw new Error('Input symlink escapes packet boundary')
  relativeName(path.relative(base, actual)) // aliases cannot conceal a prohibited canonical component
  const stat = await lstat(actual)
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('Input has wrong file type')
  return actual
}

async function inventory(directory, packet, found = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (prohibited.test(entry.name)) throw new Error('Disallowed source filename')
    const filename = path.join(directory, entry.name)
    // Reject directory links rather than following cycles or reading an unrelated tree.
    if (entry.isSymbolicLink()) throw new Error('Source tree symlinks are not accepted')
    if (entry.isDirectory()) await inventory(filename, packet, found)
    else if (entry.isFile()) {
      const actual = await realpath(filename)
      if (!inside(packet, actual)) throw new Error('Source file escapes packet boundary')
      relativeName(path.relative(packet, actual))
      found.push(actual)
      if (found.length > 10000) throw new Error('Source inventory exceeds 10000 files')
    } else throw new Error('Source tree contains an unsupported file type')
  }
  return found
}

async function binding(file) {
  const bytes = await readFile(file)
  return { file, sha256: hash(bytes), bytes: bytes.length }
}
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })

// Fixed executable plus argument arrays; no packet or manifest string becomes shell code.
// Kill the process tree while its parent is still alive, including preview's renderer child.
export function runProcess(
  command,
  args,
  { cwd = root, timeoutMs = 30000, env = process.env, maxBytes = 4 * 1024 * 1024 } = {},
) {
  return new Promise((resolve) => {
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure = null,
      settled = false
    let child,
      forcedFinish,
      treeKill = null,
      forcedSettlement = false
    const stop = (reason) => {
      if (failure) return
      failure = reason
      if (child.pid) {
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 3000,
            stdio: 'ignore',
          })
          treeKill = {
            method: 'taskkill /T /F',
            exitCode: killed.status,
            error: killed.error?.code ?? null,
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
            treeKill = { method: 'process-group SIGKILL', exitCode: 0 }
          } catch (error) {
            treeKill = { method: 'process-group SIGKILL', exitCode: null, error: error.code }
          }
        }
      }
      child.kill('SIGKILL')
      forcedFinish = setTimeout(() => {
        forcedSettlement = true
        child.stdout.destroy()
        child.stderr.destroy()
        finish(null, 'SIGKILL')
      }, 4000)
    }
    const finish = (exitCode, signal, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forcedFinish)
      resolve({
        pid: child.pid ?? null,
        exitCode,
        signal,
        failure: failure ?? (error ? 'SPAWN_ERROR' : null),
        error: error?.message ?? null,
        treeKill,
        forcedSettlement,
        cleanupUnconfirmed: Boolean(forcedSettlement || (failure && treeKill?.exitCode !== 0)),
        stdout,
        stderr,
      })
    }
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        failure: 'SPAWN_ERROR',
        error: error.message,
        stdout,
        stderr,
      })
      return
    }
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs)
    for (const [stream, name] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ]) {
      stream.on('data', (chunk) => {
        const remaining = Math.max(0, maxBytes - bytes)
        const text = chunk.subarray(0, remaining).toString('utf8')
        if (name === 'stdout') stdout += text
        else stderr += text
        bytes += chunk.length
        if (bytes > maxBytes) stop('OUTPUT_LIMIT')
      })
    }
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

async function prepareVenue(spec, base) {
  const partialInputs = []
  try {
    const packet = await bounded(base, spec.packet, true)
    const files = {}
    for (const [name, fallback] of [
      ['package', 'package.json'],
      ['ledger', 'source-ledger.json'],
      ['coverage', 'coverage.json'],
    ]) {
      files[name] = await bounded(packet, spec[name] ?? fallback)
      partialInputs.push(await binding(files[name]))
    }
    files.sources = await bounded(packet, spec.sources ?? 'sources', true)
    const inputs = [
      files.package,
      files.ledger,
      files.coverage,
      ...(await inventory(files.sources, packet)),
    ]
    let acceptance = null
    if (spec.acceptanceManifest !== undefined) {
      files.acceptanceManifest = await bounded(packet, spec.acceptanceManifest)
      inputs.push(files.acceptanceManifest)
      partialInputs.push(await binding(files.acceptanceManifest))
      acceptance = JSON.parse(await readFile(files.acceptanceManifest, 'utf8'))
      if (
        !object(acceptance) ||
        acceptance.schemaVersion !== 1 ||
        typeof acceptance.tenantId !== 'string' ||
        !acceptance.tenantId.trim() ||
        typeof acceptance.venueId !== 'string' ||
        !acceptance.venueId.trim() ||
        !object(acceptance.evidence ?? {})
      )
        throw new Error('Invalid acceptance identity or manifest')
      // The manifest identity must be the batch venue's own; otherwise one venue could carry another's evidence.
      if (acceptance.venueId !== spec.id)
        throw new Error(
          `Acceptance manifest venueId does not match batch venue id (${spec.id}); evidence cannot be borrowed across venues`,
        )
      if (spec.tenantId !== undefined && acceptance.tenantId !== spec.tenantId)
        throw new Error('Acceptance manifest tenantId does not match batch venue tenantId')
      const manifestBase = path.dirname(files.acceptanceManifest)
      const packageFile = await bounded(manifestBase, acceptance.package)
      if (key(packageFile) !== key(files.package))
        throw new Error('Acceptance package must be the packet package')
      acceptance = { ...acceptance, package: files.package, evidence: { ...acceptance.evidence } }
      for (const [kind, evidence] of Object.entries(acceptance.evidence)) {
        if (['coverage', 'guidePreview'].includes(kind)) {
          delete acceptance.evidence[kind]
          continue
        }
        if (!suppliedKinds.has(kind)) throw new Error(`Unknown acceptance evidence kind: ${kind}`)
        if (!object(evidence)) throw new Error('Invalid evidence reference')
        const file = await bounded(manifestBase, evidence.file)
        if (!inside(packet, file)) throw new Error('Evidence escapes packet')
        inputs.push(file)
        partialInputs.push(await binding(file))
        acceptance.evidence[kind] = { ...evidence, file }
      }
    }
    return {
      packet,
      files,
      acceptance,
      inputs: await Promise.all([...new Set(inputs)].sort().map(binding)),
    }
  } catch (error) {
    error.inputBindings = partialInputs
    throw error
  }
}

function readinessCoverage(report) {
  return (
    report.passed === true &&
    report.rows?.length > 0 &&
    report.rows.every(
      (r) =>
        ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'].includes(r.status) &&
        ['DISCLOSE', 'NONE'].includes(r.publishImpact) &&
        (r.status !== 'UNKNOWN' || r.publishImpact === 'DISCLOSE'),
    )
  )
}
function readinessPreview(report, packageHash) {
  return (
    report.schemaVersion === 1 &&
    report.packageSha256 === packageHash &&
    report.scope === 'CREATE_ONLY_PACKAGE_PREVIEW' &&
    ['default', 'evidence'].every(
      (s) =>
        ['FULL', 'DIRECTORY'].includes(report[s]?.mode) &&
        Number.isInteger(report[s]?.renderedChars) &&
        report[s].renderedChars > 0 &&
        report[s].maxFullChars === 120000 &&
        report[s].rendererTruncated === false,
    )
  )
}

// toolRunner is a library-only seam for deterministic child-failure tests; CLI never accepts executable overrides.
export async function runBatch({
  manifestPath,
  outputDir,
  timeoutMs = 30000,
  toolRunner = runProcess,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300000)
    throw new Error('timeoutMs must be 10..300000')
  if ([manifestPath, outputDir].some((p) => typeof p !== 'string' || /^[/\\]{2}/.test(p)))
    throw new Error('Manifest and output must use local filesystem paths')
  const lexicalManifest = path.resolve(manifestPath)
  relativeName(path.relative(path.parse(lexicalManifest).root, lexicalManifest))
  const manifestFile = await realpath(manifestPath)
  if (/^[/\\]{2}/.test(manifestFile))
    throw new Error('Canonical manifest must be a local filesystem path')
  relativeName(path.relative(path.parse(manifestFile).root, manifestFile))
  const raw = await readFile(manifestFile)
  const manifest = JSON.parse(raw)
  if (
    !object(manifest) ||
    manifest.schemaVersion !== 1 ||
    !timestamp(manifest.asOf) ||
    !Array.isArray(manifest.venues) ||
    !manifest.venues.length
  )
    throw new Error(
      'Invalid batch manifest: schemaVersion 1, UTC asOf and nonempty venues required',
    )
  const base = path.dirname(manifestFile)
  const ids = new Set(),
    destinations = new Set()
  for (const v of manifest.venues) {
    if (
      !object(v) ||
      !segment(v.id) ||
      !segment(v.destination) ||
      ids.has(v.id.toLowerCase()) ||
      destinations.has(v.destination.toLowerCase())
    )
      throw new Error('Venue ids and safe destinations must be unique (case insensitive)')
    ids.add(v.id.toLowerCase())
    destinations.add(v.destination.toLowerCase())
    if (
      v.checks !== undefined &&
      (!Array.isArray(v.checks) ||
        !v.checks.length ||
        new Set(v.checks).size !== v.checks.length ||
        v.checks.some((c) => !checks.includes(c)))
    )
      throw new Error('checks must be a nonempty unique list of supported checks')
    if (v.checks?.includes('acceptance') && checks.some((c) => !v.checks.includes(c)))
      throw new Error('acceptance requires all four checks in this run')
  }
  const absoluteOutput = path.resolve(outputDir)
  // Canonical parent identity prevents aliases/symlinks from bypassing collision checks.
  const parent = await realpath(path.dirname(absoluteOutput))
  if (key(parent) !== key(path.dirname(absoluteOutput)))
    throw new Error('Output ancestry must not contain symlinks')
  const output = path.join(parent, path.basename(absoluteOutput))
  if (!segment(path.basename(output)))
    throw new Error('Output directory needs a safe single-segment name')
  try {
    await lstat(output)
    throw new Error('Output directory already exists; choose a new destination for every run')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const prepared = []
  for (const spec of manifest.venues) {
    // Output/input overlaps are a batch invocation error, even if the packet is otherwise invalid.
    const lexicalPacket = path.resolve(base, relativeName(spec.packet))
    if (inside(lexicalPacket, output) || inside(output, lexicalPacket))
      throw new Error('Output directory overlaps an input packet')
    let canonicalPacket = null
    try {
      canonicalPacket = await realpath(lexicalPacket)
    } catch {}
    if (canonicalPacket && (inside(canonicalPacket, output) || inside(output, canonicalPacket)))
      throw new Error('Output overlaps canonical input packet')
    try {
      const value = await prepareVenue(spec, base)
      prepared.push({ spec, value })
    } catch (error) {
      prepared.push({ spec, error: error.message, inputBindings: error.inputBindings ?? [] })
    }
    const preparedPacket = prepared.at(-1).value?.packet
    if (preparedPacket && (inside(preparedPacket, output) || inside(output, preparedPacket)))
      throw new Error('Output overlaps canonical input packet')
  }
  await mkdir(output) // exclusive reservation: no resume or replacement of prior evidence
  const results = []
  for (const item of prepared) {
    const { spec, value } = item
    const venueDir = path.join(output, spec.destination)
    await mkdir(venueDir)
    const temp = path.join(venueDir, 'tmp')
    await mkdir(temp)
    const result = {
      id: spec.id,
      destination: spec.destination,
      requestedChecks: spec.checks ?? checks,
      inputBindings: value?.inputs ?? item.inputBindings ?? [],
      stages: {},
      errors: [],
      requestedChecksPassed: false,
      structural: {
        status: 'NOT_MEASURED',
        scope:
          'Production guide package parsing and rendering only; no check_package observation is created.',
      },
      sourceIntegrity: { status: 'NOT_MEASURED' },
      freshness: { status: 'NOT_MEASURED' },
      publicationReadiness: {
        verdict: 'NOT_READY',
        readinessPassed: false,
        reason: 'No complete acceptance receipt',
      },
    }
    if (item.error) result.errors.push(item.error)
    else {
      const packageHash = value.inputs.find((b) => b.file === value.files.package).sha256
      const reports = {}
      for (const name of checks.filter((name) => result.requestedChecks.includes(name))) {
        const reportFile = path.join(venueDir, `${name}.json`)
        try {
          let args
          if (name === 'sourceIntegrity')
            args = [
              'scripts/venue-source-audit.mjs',
              '--ledger',
              value.files.ledger,
              '--sources-dir',
              value.files.sources,
              '--as-of',
              manifest.asOf.slice(0, 10),
              '--output',
              reportFile,
            ]
          if (name === 'coverage')
            args = [
              'scripts/venue-coverage/check.mjs',
              '--package',
              value.files.package,
              '--ledger',
              value.files.ledger,
              '--coverage',
              value.files.coverage,
              '--sources',
              value.files.sources,
              '--as-of',
              manifest.asOf.slice(0, 10),
              '--output',
              reportFile,
            ]
          if (name === 'guidePreview')
            args = [
              'scripts/venue-guide-preview.mjs',
              '--package',
              value.files.package,
              '--as-of',
              manifest.asOf.slice(0, 10),
              '--output',
              reportFile,
            ]
          if (name === 'acceptance') {
            if (!value.acceptance)
              throw new Error(
                'No supplied acceptance manifest/tenant/venue identity; hosted evidence is not invented',
              )
            const composed = structuredClone(value.acceptance)
            for (const kind of ['coverage', 'guidePreview'])
              if (reports[kind]) {
                const envelopeFile = path.join(venueDir, `${kind}-envelope.json`)
                const expiresAt = new Date(Date.parse(manifest.asOf) + 1).toISOString()
                await save(envelopeFile, {
                  schemaVersion: 1,
                  kind,
                  tenantId: composed.tenantId,
                  venueId: composed.venueId,
                  packageSha256: packageHash,
                  measuredAt: manifest.asOf,
                  expiresAt,
                  environment: 'local',
                  data: reports[kind],
                })
                composed.evidence[kind] = {
                  file: envelopeFile,
                  sha256: (await binding(envelopeFile)).sha256,
                }
              }
            const composedPath = path.join(venueDir, 'acceptance-manifest.json')
            await save(composedPath, composed)
            await save(path.join(venueDir, 'acceptance-origin.json'), {
              suppliedManifest: value.inputs.find((b) => b.file === value.files.acceptanceManifest),
              generatedLocalEvidence: ['coverage', 'guidePreview'].filter((k) => reports[k]),
              note: 'Supplied hosted envelopes are unchanged. Local envelopes are valid only at the exact requested asOf instant.',
            })
            args = [
              'scripts/venue-acceptance-receipt.mjs',
              '--manifest',
              composedPath,
              '--as-of',
              manifest.asOf,
              '--output',
              reportFile,
            ]
          }
          let toolBinding = null
          try {
            toolBinding = await binding(path.join(root, args[0]))
          } catch {}
          const child = await toolRunner(process.execPath, args, {
            cwd: root,
            timeoutMs,
            env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
          })
          let finalToolBinding = null
          try {
            finalToolBinding = await binding(path.join(root, args[0]))
          } catch {}
          if (JSON.stringify(toolBinding) !== JSON.stringify(finalToolBinding))
            child.failure = 'TOOL_CHANGED_DURING_RUN'
          await save(path.join(venueDir, `${name}-process.json`), {
            command: process.execPath,
            args,
            timeoutMs,
            toolBinding,
            finalToolBinding,
            ...child,
          })
          let report = null
          try {
            report = JSON.parse(await readFile(reportFile, 'utf8'))
          } catch {}
          // A child may save negative evidence and exit 1. Preserve both instead of losing its report.
          const stage = {
            status: report ? 'MEASURED' : 'NOT_MEASURED',
            readinessPassed: false,
            processPassed: !child.failure && child.exitCode === 0,
            report: report ? await binding(reportFile) : null,
            failure: child.failure ?? (!report ? 'MISSING_OR_INVALID_REPORT' : null),
            exitCode: child.exitCode,
          }
          if (report) reports[name] = report
          if (name === 'sourceIntegrity' && report) {
            result.sourceIntegrity = report.integrity ?? { status: 'NOT_MEASURED' }
            result.freshness = report.freshness ?? { status: 'NOT_MEASURED' }
            stage.readinessPassed =
              report.passed === true &&
              report.integrity?.status === 'PASS' &&
              report.freshness?.status === 'PASS'
          }
          if (name === 'coverage' && report) {
            stage.checkPassed = report.passed === true
            stage.readinessPassed = readinessCoverage(report)
          }
          if (name === 'guidePreview' && report) {
            stage.readinessPassed = readinessPreview(report, packageHash)
            result.structural.status = stage.readinessPassed ? 'PASS' : 'FAIL'
          }
          if (name === 'acceptance' && report) {
            stage.readinessPassed =
              report.verdict === 'PUBLISH_CANDIDATE' &&
              Object.values(report.fields ?? {}).length === 9 &&
              Object.values(report.fields).every(
                (f) => f.status === 'MEASURED' && f.readinessPassed === true,
              )
            result.publicationReadiness = {
              verdict: stage.readinessPassed ? 'PUBLISH_CANDIDATE' : 'NOT_READY',
              readinessPassed: stage.readinessPassed,
              acceptanceVerdict: report.verdict,
              missingItems: report.missingItems ?? [],
            }
          }
          result.stages[name] = stage
          if (!stage.processPassed || !stage.readinessPassed)
            result.errors.push(
              `${name}: ${stage.failure ?? 'requested readiness predicates failed'}`,
            )
        } catch (error) {
          result.stages[name] = {
            status: 'NOT_MEASURED',
            readinessPassed: false,
            processPassed: false,
            failure: error.message,
          }
          result.errors.push(`${name}: ${error.message}`)
          await save(path.join(venueDir, `${name}-failure.json`), result.stages[name])
        }
      }
      // Input changes invalidate this run; hashes are retained before and after.
      try {
        result.finalInputBindings = await Promise.all(value.inputs.map((b) => binding(b.file)))
        if (JSON.stringify(result.finalInputBindings) !== JSON.stringify(value.inputs))
          result.errors.push('Input bytes changed during the run')
      } catch (error) {
        result.errors.push(`Input unavailable after run: ${error.message}`)
      }
    }
    result.requestedChecksPassed = result.errors.length === 0
    if (!result.requestedChecksPassed && result.publicationReadiness.readinessPassed) {
      result.publicationReadiness.readinessPassed = false
      result.publicationReadiness.verdict = 'NOT_READY'
      result.publicationReadiness.reason =
        'A requested local check failed; acceptance alone cannot promote this batch result'
    }
    // acceptance.json must never say PUBLISH_CANDIDATE when the final result is NOT_READY.
    const acceptanceStage = result.stages.acceptance
    if (
      !result.requestedChecksPassed &&
      acceptanceStage?.report &&
      acceptanceStage.status === 'MEASURED'
    ) {
      const reportFile = path.join(venueDir, 'acceptance.json')
      const childFile = path.join(venueDir, 'acceptance-child-report.json')
      try {
        const original = JSON.parse(await readFile(reportFile, 'utf8'))
        if (original.verdict === 'PUBLISH_CANDIDATE') {
          await rename(reportFile, childFile)
          await save(reportFile, {
            ...original,
            verdict: 'NOT_READY',
            childVerdict: original.verdict,
            batchDowngrade: {
              reason: result.publicationReadiness.reason,
              errors: [...result.errors],
              originalReport: 'acceptance-child-report.json',
            },
          })
          acceptanceStage.originalReport = await binding(childFile)
          acceptanceStage.report = await binding(reportFile)
        }
      } catch (error) {
        result.errors.push(`acceptance verdict reconciliation failed: ${error.message}`)
        result.requestedChecksPassed = false
      }
    }
    await save(path.join(venueDir, 'result.json'), result)
    results.push(result)
  }
  const report = {
    schemaVersion: 1,
    tool: 'venue-authoring-batch',
    asOf: manifest.asOf,
    manifest: { file: manifestFile, sha256: hash(raw) },
    outputDirectory: output,
    toolBindings: await Promise.all(
      [
        'scripts/venue-authoring-batch.mjs',
        'scripts/venue-source-audit.mjs',
        'scripts/venue-coverage/check.mjs',
        'scripts/venue-guide-preview.mjs',
        'scripts/venue-acceptance-receipt.mjs',
      ].map(async (name) => {
        try {
          return await binding(path.join(root, name))
        } catch {
          return { file: path.join(root, name), status: 'UNAVAILABLE' }
        }
      }),
    ),
    requestedChecksPassed: results.every((r) => r.requestedChecksPassed),
    venues: results,
    summary: {
      venues: results.length,
      passed: results.filter((r) => r.requestedChecksPassed).length,
      failed: results.filter((r) => !r.requestedChecksPassed).length,
      publishCandidates: results.filter((r) => r.publicationReadiness.readinessPassed).length,
    },
    note: 'Local measurement, retained byte integrity, source freshness and publication readiness are separate. No semantic truth, extraction fidelity, hosted observation or publishing authority is inferred.',
  }
  await save(path.join(output, 'batch-result.json'), report)
  await writeFile(
    path.join(output, 'summary.txt'),
    `${report.summary.venues} venues: ${report.summary.passed} requested checks passed; ${report.summary.failed} failed; ${report.summary.publishCandidates} publication candidates.\n${results.map((r) => `${r.id}: ${r.requestedChecksPassed ? 'PASS' : 'FAIL'}; publication ${r.publicationReadiness.verdict}; ${r.errors.join('; ')}`).join('\n')}\n`,
    { flag: 'wx' },
  )
  return report
}

export async function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--manifest', '--output-dir', '--timeout-ms'].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    )
      throw new Error('Usage: --manifest FILE --output-dir NEWDIR [--timeout-ms 30000]')
    options[args[i]] = args[i + 1]
  }
  if (!options['--manifest'] || !options['--output-dir'])
    throw new Error('--manifest and --output-dir are required')
  const report = await runBatch({
    manifestPath: options['--manifest'],
    outputDir: options['--output-dir'],
    timeoutMs: options['--timeout-ms'] === undefined ? 30000 : Number(options['--timeout-ms']),
  })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.stderr.write(
    `${report.summary.venues} venues: ${report.summary.passed} passed, ${report.summary.failed} failed; ${report.summary.publishCandidates} publication candidates.\n`,
  )
  return report.requestedChecksPassed ? 0 : 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 2
    })
