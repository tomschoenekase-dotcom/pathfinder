import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const device = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const inside = (root, file) => {
  const relative = path.relative(root, file)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}
function day(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}
function instant(value) {
  if (day(value)) return Date.parse(value)
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
    ? parsed
    : null
}
function safeRelative(file) {
  return (
    text(file) &&
    !path.isAbsolute(file) &&
    !path.win32.isAbsolute(file) &&
    !/[\\:\x00-\x1f]/.test(file) &&
    file
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/[<>"|?*]/.test(part) &&
          !device.test(part),
      )
  )
}
async function ordinaryFile(file) {
  const info = await stat(file)
  if (!info.isFile()) throw new Error('not a regular file')
  return readFile(file)
}

// Checks exact retained bytes only. No extraction, fetching, source repair or semantic review.
export async function auditSources({ ledgerPath, sourcesDir, asOf }) {
  if (!day(asOf)) throw new Error('--as-of must be a real YYYY-MM-DD date')
  if (!text(ledgerPath) || !text(sourcesDir)) throw new Error('ledgerPath and sourcesDir required')
  const ledgerFile = await realpath(ledgerPath)
  const ledgerBytes = await ordinaryFile(ledgerFile)
  const ledger = JSON.parse(ledgerBytes.toString('utf8'))
  const root = await realpath(sourcesDir)
  if (!(await stat(root)).isDirectory()) throw new Error('sourcesDir must be a directory')
  const integrityErrors = []
  const freshnessErrors = []
  const bindings = {
    ledger: { file: ledgerFile, sha256: hash(ledgerBytes) },
    sourcesRoot: root,
    sources: [],
  }
  const rows = []
  let freshnessUnknown = false
  const endOfDay = Date.parse(asOf) + 86400000 - 1
  if (
    !object(ledger) ||
    ledger.schemaVersion !== 1 ||
    !Array.isArray(ledger.sources) ||
    Object.keys(ledger).some((key) => !['schemaVersion', 'sources'].includes(key))
  ) {
    integrityErrors.push('ledger: SCHEMA_INVALID: schemaVersion 1 and sources array required')
  }
  const entries = Array.isArray(ledger?.sources) ? ledger.sources : []
  if (!entries.length) integrityErrors.push('ledger: SOURCES_EMPTY: at least one source required')
  const ids = new Set()
  const files = new Map()
  const physicalFiles = new Set()
  for (const [index, source] of entries.entries()) {
    const row = {
      index,
      sourceId: object(source) && text(source.sourceId) ? source.sourceId : null,
      targets: [],
    }
    rows.push(row)
    const label = `sources[${index}]`
    const fail = (code, message) => integrityErrors.push(`${label}: ${code}: ${message}`)
    const stale = (code, message) => freshnessErrors.push(`${label}: ${code}: ${message}`)
    if (!object(source)) {
      fail('SOURCE_INVALID', 'object required')
      continue
    }
    if (
      Object.keys(source).some(
        (key) =>
          !['sourceId', 'observedAt', 'recheckBy', 'raw', 'text', 'stale', 'needsRecheck'].includes(
            key,
          ),
      )
    ) {
      fail(
        'SOURCE_FIELDS_UNSUPPORTED',
        'only documented source fields are accepted; unrecognized freshness/provenance is not ignored',
      )
    }
    if (
      !text(source.sourceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(source.sourceId) ||
      device.test(source.sourceId)
    ) {
      fail('SOURCE_ID_INVALID', 'portable non-device sourceId required')
    } else {
      const folded = source.sourceId.toLowerCase()
      if (ids.has(folded)) fail('SOURCE_ID_DUPLICATE', 'case-insensitive sourceId collision')
      ids.add(folded)
    }
    if (
      ['sha256', 'hashTarget', 'rawSha256', 'textSha256', 'rawFile', 'textFile'].some((key) =>
        Object.hasOwn(source, key),
      )
    ) {
      fail(
        'HASH_DECLARATION_UNSUPPORTED',
        'use explicit raw/text objects containing file and sha256',
      )
    }
    if (!Object.hasOwn(source, 'raw') && !Object.hasOwn(source, 'text'))
      fail('HASH_TARGET_MISSING', 'declare at least one raw or text target')
    for (const target of ['raw', 'text']) {
      if (!Object.hasOwn(source, target)) continue
      const declaration = source[target]
      const result = {
        target,
        file: object(declaration) ? (declaration.file ?? null) : null,
        status: 'FAIL',
      }
      row.targets.push(result)
      if (
        !object(declaration) ||
        !safeRelative(declaration.file) ||
        typeof declaration.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(declaration.sha256) ||
        Object.keys(declaration).some((key) => !['file', 'sha256'].includes(key))
      ) {
        fail('HASH_TARGET_INVALID', `${target} requires a safe relative file and lowercase SHA-256`)
        continue
      }
      const candidate = path.resolve(root, declaration.file)
      if (!inside(root, candidate)) {
        fail('PATH_ESCAPE', `${target} escapes sourcesDir`)
        continue
      }
      try {
        // Resolve before reading: junctions and symlinks may never widen the source root.
        const actual = await realpath(candidate)
        if (!inside(root, actual)) {
          fail('PATH_ESCAPE', `${target} resolves outside sourcesDir`)
          continue
        }
        if (actual === ledgerFile) {
          fail('INPUT_ALIAS', `${target} aliases the ledger`)
          continue
        }
        const key = actual.toLowerCase()
        if (files.has(key)) {
          fail('RETAINED_FILE_COLLISION', `${target} aliases another declared target`)
          continue
        }
        files.set(key, `${index}:${target}`)
        const info = await stat(actual)
        const physicalKey = `${info.dev}:${info.ino}`
        if (physicalFiles.has(physicalKey)) {
          fail('RETAINED_FILE_COLLISION', `${target} hardlinks another declared target`)
          continue
        }
        physicalFiles.add(physicalKey)
        const bytes = await ordinaryFile(actual)
        const actualHash = hash(bytes)
        bindings.sources.push({ sourceId: row.sourceId, target, file: actual, sha256: actualHash })
        result.actualSha256 = actualHash
        result.expectedSha256 = declaration.sha256
        if (actualHash !== declaration.sha256)
          fail('HASH_MISMATCH', `${target} retained bytes differ from declared hash`)
        else result.status = 'PASS'
      } catch (error) {
        fail('RETAINED_FILE_UNAVAILABLE', `${target}: ${error.code ?? error.message}`)
      }
    }
    const observed = instant(source.observedAt)
    if (observed === null)
      stale('OBSERVATION_INVALID', 'observedAt requires a real date or canonical UTC instant')
    else if (observed > endOfDay) stale('OBSERVATION_FUTURE', 'observedAt is after as-of day')
    for (const flag of ['stale', 'needsRecheck']) {
      if (Object.hasOwn(source, flag) && typeof source[flag] !== 'boolean')
        stale('FRESHNESS_FLAG_INVALID', `${flag} must be boolean`)
      else if (source[flag] === true) stale('RECHECK_REQUIRED', `${flag} is explicitly true`)
    }
    if (Object.hasOwn(source, 'recheckBy')) {
      const deadline = instant(source.recheckBy)
      if (deadline === null)
        stale('RECHECK_DATE_INVALID', 'recheckBy requires a real date or canonical UTC instant')
      else {
        const deadlineEnd = day(source.recheckBy) ? deadline + 86400000 - 1 : deadline
        if (observed !== null && deadlineEnd < observed)
          stale('RECHECK_BEFORE_OBSERVATION', 'recheckBy precedes observedAt')
        if (deadlineEnd < endOfDay)
          stale('RECHECK_OVERDUE', 'recheckBy is before the end of the as-of day')
      }
    } else {
      freshnessUnknown = true
      stale(
        'FRESHNESS_NOT_VERIFIED',
        'no explicit recheckBy condition; no age threshold is inferred',
      )
    }
  }
  const freshnessFailures = freshnessErrors.some(
    (error) => !error.includes(': FRESHNESS_NOT_VERIFIED:'),
  )
  const integrity = { status: integrityErrors.length ? 'FAIL' : 'PASS', errors: integrityErrors }
  const freshness = {
    status: freshnessFailures
      ? 'FAIL'
      : freshnessUnknown || !entries.length
        ? 'NOT_VERIFIED'
        : 'PASS',
    errors: freshnessErrors,
  }
  return {
    schemaVersion: 1,
    tool: 'venue-source-audit',
    asOf,
    passed: integrity.status === 'PASS' && freshness.status === 'PASS',
    integrity,
    freshness,
    semantic: { status: 'NOT_VERIFIED' },
    extraction: { status: 'NOT_VERIFIED' },
    bindings,
    sources: rows,
    errors: [...integrityErrors, ...freshnessErrors],
  }
}

async function safeOutput(output, { ledgerPath, sourcesDir }) {
  const destination = path.resolve(output)
  const root = await realpath(sourcesDir)
  const ledger = await realpath(ledgerPath)
  if (
    destination.toLowerCase() === ledger.toLowerCase() ||
    destination.toLowerCase() === root.toLowerCase() ||
    inside(root, destination)
  )
    throw new Error('output must be outside source inputs')
  if (!safeRelative(path.basename(destination))) throw new Error('unsafe output filename')
  let ancestor = path.dirname(destination)
  while (true) {
    const info = await lstat(ancestor)
    if (info.isSymbolicLink()) throw new Error('output ancestor is a symlink or junction')
    if (!info.isDirectory()) throw new Error('output ancestor must be a directory')
    const next = path.dirname(ancestor)
    if (next === ancestor) break
    ancestor = next
  }
  // A lexical path outside the input root can still alias it through a root alias.
  const actualParent = await realpath(path.dirname(destination))
  const actualDestination = path.join(actualParent, path.basename(destination))
  if (
    actualDestination.toLowerCase() === ledger.toLowerCase() ||
    actualDestination.toLowerCase() === root.toLowerCase() ||
    inside(root, actualDestination)
  )
    throw new Error('output aliases source inputs')
  return destination
}
export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = {}
    const flags = {
      '--ledger': 'ledgerPath',
      '--sources-dir': 'sourcesDir',
      '--sources': 'sourcesDir',
      '--as-of': 'asOf',
      '--output': 'output',
    }
    for (let index = 0; index < argv.length; index += 2) {
      const key = flags[argv[index]]
      if (
        !key ||
        !text(argv[index + 1]) ||
        argv[index + 1].startsWith('--') ||
        Object.hasOwn(options, key)
      )
        throw new Error('unknown, duplicate or missing CLI argument')
      options[key] = argv[index + 1]
    }
    if (['ledgerPath', 'sourcesDir', 'asOf', 'output'].some((key) => !text(options[key])))
      throw new Error('Required: --ledger --sources-dir --as-of --output')
    const output = await safeOutput(options.output, options)
    // Exclusive create also refuses an existing symlink, including a dangling one.
    const report = await auditSources(options)
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    io.stdout.write(
      `${JSON.stringify({ output, passed: report.passed, integrity: report.integrity.status, freshness: report.freshness.status })}\n`,
    )
    return report.passed ? 0 : 1
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ tool: 'venue-source-audit', error: error.message })}\n`)
    return 2
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
