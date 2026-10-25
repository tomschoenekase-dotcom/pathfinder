// Read-only recheck register: turns a venue's coverage rows into per-record deadlines keyed by
// package itemKey, so a published venue can be rechecked record by record after import.
// It never edits inputs, contacts sources or decides truth.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkerVersion, labeledRecordFindings, pointer } from './venue-coverage/check.mjs'

const isDate = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export function buildRecheckRegister(pkg, coverage, asOf) {
  if (!isDate(asOf)) throw new Error('--as-of must be a real YYYY-MM-DD date')
  if (!Array.isArray(coverage?.rows)) throw new Error('coverage rows required')
  const entries = new Map()
  for (const row of coverage.rows) {
    for (const ref of Array.isArray(row?.records) ? row.records : []) {
      const base = String(ref).split('/').slice(0, 4).join('/')
      let record
      try {
        record = pointer(pkg, base)
      } catch {
        continue
      }
      const entry = entries.get(base) ?? {
        record: base,
        itemKey: record?.itemKey ?? null,
        title: record?.value?.title ?? record?.value?.name ?? null,
        categories: [],
        recheckBy: null,
      }
      entry.categories.push({
        category: row.category,
        status: row.status,
        recheckBy: row.recheckBy ?? null,
      })
      // The earliest deadline across a record's categories governs the record.
      if (isDate(row.recheckBy) && (!entry.recheckBy || row.recheckBy < entry.recheckBy))
        entry.recheckBy = row.recheckBy
      entries.set(base, entry)
    }
  }
  const unbound = labeledRecordFindings(pkg, coverage.rows)
  for (const finding of unbound) {
    const entry = entries.get(finding.record) ?? {
      record: finding.record,
      itemKey: pointer(pkg, finding.record)?.itemKey ?? null,
      title: finding.title,
      categories: [],
      recheckBy: null,
    }
    entry.unboundCategories = [...(entry.unboundCategories ?? []), finding.category]
    entries.set(finding.record, entry)
  }
  const rows = [...entries.values()].map((entry) => {
    const state = entry.unboundCategories?.length
      ? 'UNBOUND_LABELED_FACT'
      : !entry.recheckBy
        ? 'NO_DEADLINE'
        : entry.recheckBy < asOf
          ? 'OVERDUE'
          : 'CURRENT'
    return {
      ...entry,
      state,
      daysLeft: entry.recheckBy ? daysBetween(asOf, entry.recheckBy) : null,
    }
  })
  rows.sort((a, b) => a.record.localeCompare(b.record, 'en', { numeric: true }))
  const count = (state) => rows.filter((row) => row.state === state).length
  return {
    schemaVersion: 1,
    asOf,
    summary: {
      records: rows.length,
      overdue: count('OVERDUE'),
      unboundLabeledFacts: count('UNBOUND_LABELED_FACT'),
      noDeadline: count('NO_DEADLINE'),
      current: count('CURRENT'),
    },
    rows,
    scope:
      'Deadlines come from authored coverage rows. A CURRENT record is not verified as true; an OVERDUE or UNBOUND record needs a fresh official recheck before it is treated as current.',
  }
}

export async function main(args) {
  const names = {
    '--package': 'package',
    '--coverage': 'coverage',
    '--as-of': 'asOf',
    '--output': 'output',
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]]
    if (!name || !args[i + 1] || options[name]) throw new Error('invalid or duplicate CLI argument')
    options[name] = args[i + 1]
  }
  if (!options.package || !options.coverage || !options.asOf)
    throw new Error('Required: --package --coverage --as-of [--output]')
  const [pkgBytes, coverageBytes] = await Promise.all([
    readFile(options.package),
    readFile(options.coverage),
  ])
  const register = buildRecheckRegister(
    JSON.parse(pkgBytes.toString('utf8')),
    JSON.parse(coverageBytes.toString('utf8')),
    options.asOf,
  )
  const sha = (b) => createHash('sha256').update(b).digest('hex')
  register.bindings = {
    checker: await checkerVersion(),
    package: { file: path.resolve(options.package), sha256: sha(pkgBytes) },
    coverage: { file: path.resolve(options.coverage), sha256: sha(coverageBytes) },
  }
  const text = JSON.stringify(register, null, 2) + '\n'
  if (options.output) {
    const output = path.resolve(options.output)
    if ([options.package, options.coverage].map((p) => path.resolve(p)).includes(output))
      throw new Error('output must not overwrite an input')
    await writeFile(output, text, { flag: 'wx' })
  } else process.stdout.write(text)
  return register.summary.overdue || register.summary.unboundLabeledFacts ? 1 : 0
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
