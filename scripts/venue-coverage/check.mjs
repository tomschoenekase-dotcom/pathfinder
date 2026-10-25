import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

export const categories = [
  'hours-season',
  'closures',
  'admission-prices',
  'tickets-booking',
  'address-parking',
  'contact',
  'accessibility',
  'food-allergen-policy',
  'pets-service-animals',
  'weather-policy',
]
const profiles = ['amusement', 'zoo-wildlife', 'museum', 'garden', 'other']
const statuses = ['KNOWN', 'UNKNOWN', 'CONFLICTED', 'NOT_APPLICABLE', 'NEEDS_HUMAN']
const impacts = ['BLOCKS', 'DISCLOSE', 'NONE']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0
const date = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v
function keys(value, allowed) {
  return Object.keys(value).every((k) => allowed.includes(k))
}
export function pointer(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('/') || /~(?![01])/.test(ref))
    throw new Error('invalid JSON pointer')
  return ref
    .slice(1)
    .split('/')
    .reduce((value, token) => {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
      if (
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        value === null ||
        typeof value !== 'object' ||
        !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))
      )
        throw new Error('missing or unsafe JSON pointer')
      return value[key]
    }, document)
}
// Accept only authored create/update records or their guest-facing text fields.
// Provenance, ids, booleans and whole-package/container pointers are not disclosures.
export function guestRecordText(document, ref) {
  const match =
    typeof ref === 'string' &&
    ref.match(
      /^\/(places|knowledgeEntries)\/(create|update)\/(0|[1-9]\d*)(?:\/value(?:\/([A-Za-z]+))?)?$/,
    )
  if (!match) throw new Error('pointer must identify an authored guest record or text field')
  const record = pointer(document, `/${match[1]}/${match[2]}/${match[3]}`)
  const value = record?.value
  if (match[1] === 'knowledgeEntries' && record?.provenance?.sourceType === 'SOURCE_CONNECTION')
    throw new Error('SOURCE_CONNECTION knowledge is excluded from guest publication')
  if (!object(value)) throw new Error('guest record value missing')
  if (value.isEnabled === false || value.isActive === false)
    throw new Error('guest record is disabled or inactive')
  const fields =
    match[1] === 'knowledgeEntries'
      ? ['title', 'content']
      : ['name', 'shortDescription', 'longDescription', 'hours', 'areaName']
  const field = match[4]
  for (const flag of ['isEnabled', 'isActive'])
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean')
      throw new Error(`guest record ${flag} must be boolean`)
  if (field && !fields.includes(field)) throw new Error('pointer is not guest-facing text')
  const text = field ? [pointer(document, ref)] : fields.map((key) => value[key])
  const result = text.filter(nonempty)
  if (!result.length) throw new Error('guest record has no text')
  return result
}
// A disclosure is a body line that says "unconfirmed" without negating it. Titles alone do not
// count: a guest can receive a record body without reading "Unconfirmed" as a caution.
const negatedUnconfirmed =
  /\b(?:not|no|no longer|never|without|isn['’]t|aren['’]t|wasn['’]t)\s+unconfirmed\b/i
export function bodyDiscloses(document, ref) {
  const parts = ref.split('/')
  const value = pointer(document, parts.slice(0, 4).join('/'))?.value ?? {}
  const field = parts[5]
  const bodyFields =
    parts[1] === 'knowledgeEntries' ? ['content'] : ['shortDescription', 'longDescription', 'hours']
  const fields = field ? bodyFields.filter((name) => name === field) : bodyFields
  return fields
    .flatMap((name) => (nonempty(value[name]) ? value[name].split(/\r?\n|(?<=[.!?])\s+/u) : []))
    .some((line) => /\bunconfirmed\b/i.test(line) && !negatedUnconfirmed.test(line))
}
// Canonical v4 labels that make a record carry a time-sensitive or safety fact. Every such
// record must be bound to its category row, so a human resolution (or a recheck) reaches all
// copies of the fact instead of one summary record.
const labeledCategories = [
  ['hours-season', /^(?:Hours|Closed|Season)\s*:/imu],
  ['admission-prices', /^(?:Price|Prices|Admission|Cost)\s*:/imu],
  ['closures', /^Status\s*:/imu],
  ['rider-height-safety', /^Height\s*:/imu],
]
export function labeledRecordFindings(document, rows) {
  const bound = new Map()
  for (const row of rows)
    if (object(row) && Array.isArray(row.records))
      bound.set(
        row.category,
        new Set(row.records.map((ref) => String(ref).split('/').slice(0, 4).join('/'))),
      )
  const findings = []
  for (const group of ['knowledgeEntries', 'places'])
    for (const op of ['create', 'update']) {
      const list = document?.[group]?.[op]
      if (!Array.isArray(list)) continue
      list.forEach((record, index) => {
        const value = record?.value
        if (!object(value) || value.isEnabled === false || value.isActive === false) return
        if (group === 'knowledgeEntries' && record?.provenance?.sourceType === 'SOURCE_CONNECTION')
          return
        const ref = `/${group}/${op}/${index}`
        const body = group === 'knowledgeEntries' ? value.content : value.longDescription
        for (const [category, label] of labeledCategories) {
          const labeled =
            (nonempty(body) && label.test(body)) ||
            (category === 'hours-season' && group === 'places' && nonempty(value.hours))
          if (!labeled || bound.get(category)?.has(ref)) continue
          // A dated event's own Hours line may be governed by the events row instead.
          if (category === 'hours-season' && bound.get('events')?.has(ref)) continue
          findings.push({
            category,
            record: ref,
            title: value.title ?? value.name ?? null,
            reason: bound.has(category)
              ? 'labeled record is not bound to its coverage category row'
              : 'labeled record has no coverage row for its category',
          })
        }
      })
    }
  return findings
}
const coreCategories = ['hours-season', 'admission-prices', 'address-parking', 'contact']
const timeSensitive = ['hours-season', 'closures', 'admission-prices', 'events']
const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000
const MIN_SPAN_CHARS = 8
// Reuse the production temporal classifier. The current renderer preserves raw text,
// including research prose; legacy guest-facing sanitizers do not govern eligibility. Resolve only
// already-installed dependencies; no CLI/package-manager/network fallback is permitted.
let guestVisibilityHelpers
async function loadGuestVisibilityHelpers() {
  guestVisibilityHelpers ??= (async () => {
    let loaderPath
    for (const anchor of [
      new URL('../../packages/api/package.json', import.meta.url),
      new URL('../../node_modules/.pnpm/node_modules/tsx/package.json', import.meta.url),
    ]) {
      try {
        loaderPath = createRequire(anchor).resolve('tsx/esm/api')
        break
      } catch {
        /* Try the existing PNPM shared installation. */
      }
    }
    if (!loaderPath)
      throw new Error('installed tsx loader unavailable; guest visibility is unverified')
    const { tsImport } = await import(pathToFileURL(loaderPath).href)
    const unwrap = (module) => module.default ?? module
    const dates = unwrap(
      await tsImport(
        new URL('../../packages/api/src/lib/guest-event-dates.ts', import.meta.url).href,
        import.meta.url,
      ),
    )
    if (typeof dates.classifyGuestDatedEvent !== 'function')
      throw new Error('production guest visibility classifier unavailable')
    return dates
  })()
  return guestVisibilityHelpers
}
async function guestDisclosureText(document, ref, text, asOf) {
  const helpers = await loadGuestVisibilityHelpers()
  const parts = ref.split('/')
  const record = pointer(document, parts.slice(0, 4).join('/'))
  const value = record.value
  if (parts[1] === 'knowledgeEntries') {
    if (![value.title, value.category, value.content].every(nonempty))
      throw new Error('guest visibility unverified: knowledge title/category/content required')
    const status = helpers.classifyGuestDatedEvent(value, asOf)
    if (!['CURRENT', 'CHECK_DATES', 'PAST'].includes(status))
      throw new Error('guest visibility unverified: invalid temporal classification')
    if (status === 'PAST')
      throw new Error(
        'UNKNOWN DISCLOSE record is PAST and its body is omitted by the production guide',
      )
  }
  return text
}
export async function checkCoverage({ packagePath, ledgerPath, coveragePath, sourcesDir, asOf }) {
  if (!date(asOf)) throw new Error('--as-of must be a real YYYY-MM-DD date')
  const paths = [packagePath, ledgerPath, coveragePath]
  const bytes = await Promise.all(paths.map((p) => readFile(p)))
  const [pkg, ledger, coverage] = bytes.map((b) => JSON.parse(b.toString('utf8')))
  const errors = []
  const bindings = Object.fromEntries(
    ['package', 'ledger', 'coverage'].map((name, i) => [
      name,
      { file: path.resolve(paths[i]), sha256: hash(bytes[i]) },
    ]),
  )
  bindings.sources = []
  if (!object(pkg) || pkg.schemaVersion !== 3) errors.push('package: schemaVersion must be 3')
  if (
    !object(coverage) ||
    !keys(coverage, ['schemaVersion', 'profile', 'rows']) ||
    coverage.schemaVersion !== 1 ||
    !profiles.includes(coverage.profile) ||
    !Array.isArray(coverage.rows)
  )
    errors.push('coverage: invalid schema')
  if (!object(ledger) || !Array.isArray(ledger.sources))
    errors.push('ledger: sources array required')
  const sourceMap = new Map()
  for (const source of Array.isArray(ledger?.sources) ? ledger.sources : []) {
    if (
      !object(source) ||
      !nonempty(source.sourceId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(source.sourceId) ||
      sourceMap.has(source.sourceId)
    )
      errors.push('ledger: invalid or duplicate source id')
    else sourceMap.set(source.sourceId, source)
  }
  const required = [
    ...categories,
    ...(coverage?.profile === 'amusement'
      ? ['rider-height-safety']
      : coverage?.profile === 'zoo-wildlife'
        ? ['animal-encounter-rules']
        : []),
  ]
  const seen = new Set()
  const sourceCache = new Map()
  const root = await realpath(sourcesDir)
  for (const [i, row] of (Array.isArray(coverage?.rows) ? coverage.rows : []).entries()) {
    const fail = (message) => errors.push(`rows[${i}]: ${message}`)
    if (
      !object(row) ||
      !keys(row, [
        'category',
        'status',
        'records',
        'sources',
        'observedAt',
        'recheckBy',
        'humanDecision',
        'publishImpact',
        'rationale',
      ]) ||
      ![...categories, 'rider-height-safety', 'animal-encounter-rules', 'events'].includes(
        row.category,
      ) ||
      !statuses.includes(row.status) ||
      !impacts.includes(row.publishImpact) ||
      !Array.isArray(row.records) ||
      !Array.isArray(row.sources) ||
      !date(row.observedAt) ||
      !nonempty(row.rationale)
    ) {
      fail('invalid row schema')
      continue
    }
    if (seen.has(row.category)) fail('duplicate category')
    seen.add(row.category)
    if (row.observedAt > asOf) fail('observedAt is after as-of')
    if (
      row.recheckBy !== undefined &&
      (!date(row.recheckBy) || row.recheckBy < asOf || row.recheckBy < row.observedAt)
    )
      fail('invalid or stale recheckBy')
    if (
      timeSensitive.includes(row.category) &&
      row.status !== 'NOT_APPLICABLE' &&
      !date(row.recheckBy)
    )
      fail('recheckBy required')
    if (
      date(row.recheckBy) &&
      days(row.observedAt, row.recheckBy) > (timeSensitive.includes(row.category) ? 180 : 366)
    )
      fail('recheckBy is too far after observedAt')
    if (['NEEDS_HUMAN', 'CONFLICTED'].includes(row.status) && !nonempty(row.humanDecision))
      fail('humanDecision question required')
    if (row.humanDecision !== undefined && !nonempty(row.humanDecision))
      fail('invalid humanDecision')
    // Status and impact must agree: an unsettled category can never be published silently.
    if (
      ['UNKNOWN', 'CONFLICTED', 'NEEDS_HUMAN'].includes(row.status) &&
      row.publishImpact === 'NONE'
    )
      fail(`${row.status} requires publishImpact BLOCKS or DISCLOSE`)
    if (row.status === 'KNOWN' && row.publishImpact === 'BLOCKS')
      fail('KNOWN cannot have publishImpact BLOCKS')
    if (row.status === 'NOT_APPLICABLE') {
      if (coreCategories.includes(row.category))
        fail(`${row.category} cannot be NOT_APPLICABLE for a guest venue`)
      if (row.publishImpact !== 'NONE') fail('NOT_APPLICABLE requires publishImpact NONE')
      if (row.rationale.trim().length < 20) fail('NOT_APPLICABLE requires a specific rationale')
    }
    if (row.status === 'KNOWN' && (!row.records.length || !row.sources.length))
      fail('KNOWN requires records and sources')
    const discloses = row.status !== 'KNOWN' && row.publishImpact === 'DISCLOSE'
    if (discloses && !row.records.length) fail(`${row.status} DISCLOSE requires a package record`)
    // UNKNOWN: every cited record is a disclosure home. CONFLICTED / NEEDS_HUMAN rows may cite
    // supporting known records, but at least one current record must carry the caution (v4 keeps
    // one home per caution).
    let disclosed = false
    for (const ref of row.records) {
      try {
        const text = guestRecordText(pkg, ref)
        if (!discloses) continue
        if (row.status === 'UNKNOWN') {
          await guestDisclosureText(pkg, ref, text, asOf)
          if (!bodyDiscloses(pkg, ref))
            fail(`UNKNOWN DISCLOSE record body must state unconfirmed: ${ref}`)
        } else if (bodyDiscloses(pkg, ref)) {
          await guestDisclosureText(pkg, ref, text, asOf)
          disclosed = true
        }
      } catch (error) {
        fail(`${error.message}: ${String(ref)}`)
      }
    }
    if (discloses && row.status !== 'UNKNOWN' && row.records.length && !disclosed)
      fail(`${row.status} DISCLOSE needs at least one record body that states unconfirmed`)
    for (const span of row.sources) {
      if (
        !object(span) ||
        !keys(span, ['sourceId', 'start', 'end', 'text']) ||
        !sourceMap.has(span.sourceId) ||
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        !nonempty(span.text) ||
        span.text.trim().length < MIN_SPAN_CHARS
      ) {
        fail('invalid source span')
        continue
      }
      try {
        if (!sourceCache.has(span.sourceId)) {
          const filename = await realpath(path.join(root, `${span.sourceId}.txt`))
          const relative = path.relative(root, filename)
          if (relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('source escapes sources directory')
          const buffer = await readFile(filename)
          sourceCache.set(span.sourceId, buffer.toString('utf8'))
          bindings.sources.push({ sourceId: span.sourceId, file: filename, sha256: hash(buffer) })
        }
        const text = sourceCache.get(span.sourceId)
        if (span.end > text.length || text.slice(span.start, span.end) !== span.text)
          fail('source span does not match retained text')
      } catch (error) {
        fail(`source unavailable: ${error.message}`)
      }
    }
  }
  for (const category of required)
    if (!seen.has(category)) errors.push(`missing required category: ${category}`)
  bindings.sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  return {
    schemaVersion: 1,
    asOf,
    passed: errors.length === 0,
    verdict: errors.length ? 'FAIL' : 'PASS',
    profile: coverage?.profile,
    rows: coverage?.rows ?? [],
    errors,
    // Readiness findings never change the contract verdict above; consumers treat any entry
    // as a publication blocker (for example, labeled hours records outside the hours row).
    readinessFindings:
      object(pkg) && Array.isArray(coverage?.rows) ? labeledRecordFindings(pkg, coverage.rows) : [],
    bindings,
    scope:
      'Presence, linkage, freshness and deterministic disclosure eligibility checks only. The production temporal classifier is reused; raw renderer-retained text remains eligible; live authority and retrieval are not measured. No factual truth or publication approval is inferred.',
  }
}
export async function main(args) {
  const options = {}
  const names = {
    '--package': 'packagePath',
    '--ledger': 'ledgerPath',
    '--coverage': 'coveragePath',
    '--sources': 'sourcesDir',
    '--as-of': 'asOf',
    '--output': 'output',
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--') || options[names[args[i]]])
      throw new Error('invalid or duplicate CLI argument')
    options[names[args[i]]] = args[i + 1]
  }
  if (Object.values(names).some((name) => !options[name]))
    throw new Error('Required: --package --ledger --coverage --sources --as-of --output')
  const output = path.join(
    await realpath(path.dirname(path.resolve(options.output))),
    path.basename(options.output),
  )
  const sourceRelative = path.relative(await realpath(options.sourcesDir), output)
  if (
    (
      await Promise.all(
        [options.packagePath, options.ledgerPath, options.coveragePath].map((p) => realpath(p)),
      )
    ).some((p) => p.toLowerCase() === output.toLowerCase()) ||
    (!path.isAbsolute(sourceRelative) && sourceRelative.split(path.sep)[0] !== '..')
  )
    throw new Error('output must not overwrite inputs or be inside sources')
  const report = await checkCoverage(options)
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return report.passed ? 0 : 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
