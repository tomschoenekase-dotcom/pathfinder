import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Maps a legacy authoring source ledger into the strict ledger read by venue-source-audit.mjs.
// It only re-labels what the legacy ledger already declares: no fetching, hashing-to-repair,
// extraction or date invention. The auditor still verifies every byte. Everything the strict
// format cannot carry stays in the untouched legacy ledger and is listed in the report.

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => typeof value === 'string' && value.trim().length > 0
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const day = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value

// Legacy spellings seen in real authoring ledgers. Order is preference; ambiguity is an error.
const ID_FIELDS = ['sourceId', 'id']
const RAW_FILE_FIELDS = ['rawPath', 'rawFile', 'capturePath']
const TEXT_FILE_FIELDS = ['textPath', 'textFile']
const CARRIED = new Set([
  ...ID_FIELDS,
  ...RAW_FILE_FIELDS,
  ...TEXT_FILE_FIELDS,
  'observedAt',
  'sha256',
  'textSha256',
  'recheckBy',
  'stale',
  'needsRecheck',
])

/** Canonical UTC instant the auditor accepts. Sub-millisecond digits are truncated (earlier, never later). */
export function canonicalObservedAt(value) {
  if (day(value)) return { value }
  if (typeof value !== 'string') return { error: 'observedAt missing' }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return { error: 'observedAt is not an ISO instant' }
  const fraction = (match[2] ?? '').padEnd(3, '0')
  const parsed = Date.parse(`${match[1]}.${fraction.slice(0, 3)}${match[3]}`)
  if (!Number.isFinite(parsed)) return { error: 'observedAt is not a real instant' }
  const canonical = new Date(parsed).toISOString()
  return {
    value: canonical,
    ...(canonical !== value ? { normalizedFrom: value } : {}),
  }
}

function single(source, fields, label, problems) {
  const present = fields.filter((field) => text(source[field]))
  const values = [...new Set(present.map((field) => source[field]))]
  if (values.length > 1) problems.push(`${label} declared differently by ${present.join(', ')}`)
  return values.length === 1 ? { field: present[0], value: values[0] } : null
}

/** Coverage rows set review deadlines per category; a source inherits the earliest row citing it. */
export function recheckByFromCoverage(coverage) {
  const bySource = new Map()
  for (const row of Array.isArray(coverage?.rows) ? coverage.rows : []) {
    if (!day(row?.recheckBy) || !Array.isArray(row.sources)) continue
    for (const cited of row.sources) {
      if (!text(cited?.sourceId)) continue
      const current = bySource.get(cited.sourceId)
      if (!current || row.recheckBy < current.recheckBy)
        bySource.set(cited.sourceId, { recheckBy: row.recheckBy, categories: [row.category] })
      else if (row.recheckBy === current.recheckBy && !current.categories.includes(row.category))
        current.categories.push(row.category)
    }
  }
  return bySource
}

export async function migrateLedger({ ledgerPath, sourcesDir, coveragePath, attestedTextPath }) {
  const ledgerFile = await realpath(ledgerPath)
  const legacy = JSON.parse(await readFile(ledgerFile, 'utf8'))
  const legacyRoot = path.dirname(ledgerFile)
  const root = await realpath(sourcesDir)
  if (!(await stat(root)).isDirectory()) throw new Error('sourcesDir must be a directory')
  const coverage = coveragePath ? JSON.parse(await readFile(coveragePath, 'utf8')) : null
  const deadlines = recheckByFromCoverage(coverage)
  const attested = attestedTextPath ? JSON.parse(await readFile(attestedTextPath, 'utf8')) : null
  if (
    attested &&
    (!object(attested) ||
      attested.schemaVersion !== 1 ||
      !text(attested.method) ||
      !object(attested.sources) ||
      Object.values(attested.sources).some((value) => !sha(value)))
  )
    throw new Error('attested text hashes need schemaVersion 1, a method and sourceId -> sha256')

  const legacySources = Array.isArray(legacy) ? legacy : legacy?.sources
  if (!Array.isArray(legacySources)) throw new Error('legacy ledger has no sources array')
  const strict = []
  const report = {
    schemaVersion: 1,
    tool: 'venue-ledger-migrate',
    legacyLedger: ledgerFile,
    sourcesRoot: root,
    coverage: coveragePath ? path.resolve(coveragePath) : null,
    attestedText: attested
      ? { file: path.resolve(attestedTextPath), method: attested.method }
      : null,
    legacyTopLevelFieldsNotCarried: Array.isArray(legacy)
      ? []
      : Object.keys(legacy).filter((key) => key !== 'sources'),
    sources: [],
    excluded: [],
    summary: {},
  }
  const seen = new Set()
  for (const [index, source] of legacySources.entries()) {
    const problems = []
    const entry = { index, sourceId: null, targets: [], notes: [], fieldsNotCarried: [] }
    if (!object(source)) {
      report.excluded.push({ index, reason: 'legacy source is not an object' })
      continue
    }
    entry.fieldsNotCarried = Object.keys(source).filter((key) => !CARRIED.has(key))
    const id = single(source, ID_FIELDS, 'source id', problems)
    entry.sourceId = id?.value ?? null
    if (!id) problems.push('no source id')
    else if (seen.has(id.value.toLowerCase())) problems.push('duplicate source id')
    else seen.add(id.value.toLowerCase())

    const strictSource = { sourceId: entry.sourceId }
    const observed = canonicalObservedAt(source.observedAt)
    if (observed.error) problems.push(observed.error)
    else {
      strictSource.observedAt = observed.value
      if (observed.normalizedFrom)
        entry.notes.push(`observedAt ${observed.normalizedFrom} written as ${observed.value}`)
    }

    const declare = (target, fileField, hashValue, hashOrigin) => {
      if (!fileField) return
      const legacyRelative = fileField.value.replaceAll('\\', '/')
      const absolute = path.resolve(legacyRoot, legacyRelative)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        entry.notes.push(
          `${target} ${legacyRelative} is outside the sources directory; not declared`,
        )
        return
      }
      if (!sha(hashValue)) {
        entry.notes.push(`${target} ${legacyRelative} has no declared SHA-256; not declared`)
        return
      }
      strictSource[target] = { file: relative, sha256: hashValue }
      entry.targets.push({ target, file: relative, hashOrigin })
    }
    const rawFile = single(source, RAW_FILE_FIELDS, 'raw file', problems)
    const textFile = single(source, TEXT_FILE_FIELDS, 'text file', problems)
    declare('raw', rawFile, source.sha256, 'legacy sha256')
    const attestedHash = entry.sourceId ? attested?.sources?.[entry.sourceId] : undefined
    if (sha(source.textSha256)) declare('text', textFile, source.textSha256, 'legacy textSha256')
    else if (attestedHash) declare('text', textFile, attestedHash, `attested: ${attested.method}`)
    else declare('text', textFile, undefined, null)

    const legacyRecheck = Object.hasOwn(source, 'recheckBy')
      ? canonicalObservedAt(source.recheckBy)
      : { error: 'absent' }
    if (legacyRecheck.value) {
      strictSource.recheckBy = legacyRecheck.value
      entry.recheckByOrigin = 'legacy recheckBy'
    } else if (entry.sourceId && deadlines.has(entry.sourceId)) {
      const derived = deadlines.get(entry.sourceId)
      strictSource.recheckBy = derived.recheckBy
      entry.recheckByOrigin = `earliest coverage row citing it (${derived.categories.join(', ')})`
    } else {
      entry.recheckByOrigin = null
      entry.notes.push('no recheckBy: no legacy date and no coverage row with a recheckBy cites it')
    }
    for (const flag of ['stale', 'needsRecheck'])
      if (typeof source[flag] === 'boolean') strictSource[flag] = source[flag]

    if (problems.length || entry.targets.length === 0) {
      report.excluded.push({
        index,
        sourceId: entry.sourceId,
        reason: problems.length ? problems.join('; ') : 'no auditable retained target',
        notes: entry.notes,
        legacyStatus: source.status ?? source.fetchStatus ?? null,
        legacyError: source.error ?? source.fetchError ?? null,
      })
      continue
    }
    strict.push(strictSource)
    report.sources.push(entry)
  }
  const cited = new Set(
    (coverage?.rows ?? []).flatMap((row) =>
      (row?.sources ?? []).map((source) => source?.sourceId).filter(text),
    ),
  )
  const carried = new Set(strict.map((source) => source.sourceId))
  report.summary = {
    legacySources: legacySources.length,
    strictSources: strict.length,
    excluded: report.excluded.length,
    withText: strict.filter((source) => source.text).length,
    withRaw: strict.filter((source) => source.raw).length,
    withRecheckBy: strict.filter((source) => source.recheckBy).length,
    withoutRecheckBy: strict.filter((source) => !source.recheckBy).map((source) => source.sourceId),
    citedByCoverageButNotCarried: [...cited].filter((id) => !carried.has(id)).sort(),
    citedByCoverageWithoutText: [...cited]
      .filter((id) => carried.has(id) && !strict.find((source) => source.sourceId === id).text)
      .sort(),
  }
  return { ledger: { schemaVersion: 1, sources: strict }, report }
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const flags = {
      '--ledger': 'ledgerPath',
      '--sources-dir': 'sourcesDir',
      '--coverage': 'coveragePath',
      '--attested-text': 'attestedTextPath',
      '--output': 'output',
      '--report': 'reportPath',
    }
    const options = {}
    for (let index = 0; index < argv.length; index += 2) {
      const key = flags[argv[index]]
      if (!key || !text(argv[index + 1]) || Object.hasOwn(options, key))
        throw new Error('unknown, duplicate or missing CLI argument')
      options[key] = argv[index + 1]
    }
    if (['ledgerPath', 'sourcesDir', 'output', 'reportPath'].some((key) => !text(options[key])))
      throw new Error(
        'Required: --ledger --sources-dir --output --report [--coverage] [--attested-text]',
      )
    const ledgerFile = await realpath(options.ledgerPath)
    for (const out of [options.output, options.reportPath])
      if (path.resolve(out).toLowerCase() === ledgerFile.toLowerCase())
        throw new Error('outputs must not overwrite the legacy ledger')
    const { ledger, report } = await migrateLedger(options)
    // Exclusive create: a migration never overwrites an earlier strict ledger or report.
    await writeFile(options.output, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' })
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    io.stdout.write(
      `${JSON.stringify({ output: path.resolve(options.output), ...report.summary })}\n`,
    )
    return 0
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ tool: 'venue-ledger-migrate', error: error.message })}\n`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main()
