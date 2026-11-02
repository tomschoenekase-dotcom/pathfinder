/**
 * Offline venue package check, for packages with no venue binding yet.
 *
 *   pnpm venue:check <package.json> [--official-domain example.org] [--now 2026-11-02T15:00:00Z] [--json]
 *
 * Exit code 0 when the package is ready offline, 1 when it is not, 2 on a usage or read error.
 * It never connects to a database or a model. venues.check_package against the target venue is
 * still required before import.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { checkVenuePackageOffline, type OfflineFinding } from './check-offline'

const out = (line: string) => process.stdout.write(`${line}\n`)
const fail = (line: string) => process.stderr.write(`${line}\n`)
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index > -1 ? process.argv[index + 1] : undefined
}

const file = process.argv.slice(2).find((value, index, all) => {
  const previous = all[index - 1]
  return !value.startsWith('--') && previous !== '--official-domain' && previous !== '--now'
})
if (!file) {
  fail('Usage: pnpm venue:check <package.json> [--official-domain host] [--now ISO] [--json]')
  process.exit(2)
}
const now = new Date(arg('--now') ?? Date.now())
if (Number.isNaN(now.getTime())) {
  fail('--now must be an ISO date-time')
  process.exit(2)
}
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file)
let json: unknown
try {
  const text = readFileSync(path, 'utf8')
  json = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text)
} catch (error) {
  fail(`Cannot read ${path}: ${(error as Error).message}`)
  process.exit(2)
}

const result = checkVenuePackageOffline(json, { now, officialDomain: arg('--official-domain') })
if (process.argv.includes('--json')) {
  out(JSON.stringify({ file: path, checkedAt: now.toISOString(), ...result }, null, 2))
} else {
  const show = (title: string, findings: OfflineFinding[]) => {
    if (findings.length === 0) return
    out(`\n${title} (${findings.length})`)
    for (const finding of findings) {
      out(`- ${finding.code} ${finding.path}\n  ${finding.message}`)
      if (finding.fix) out(`  Fix: ${finding.fix}`)
    }
  }
  out(`${path}\nChecked as of ${now.toISOString()}`)
  out(`Records: ${result.records.places} places, ${result.records.knowledge} knowledge`)
  show('Schema errors (block import)', result.errors)
  show('Writing guide (blocks ready)', result.guideQuality)
  show('Duplicates in package (block ready)', result.duplicates)
  show('Authoring advice (fix or justify each)', result.authoring)
  show('Sources off the official domain', result.sources.offOfficialDomain)
  out(
    `\nSource hosts: ${
      Object.entries(result.sources.hosts)
        .sort((a, b) => b[1] - a[1])
        .map(([host, count]) => `${host} ${count}`)
        .join(', ') || 'none'
    }; records without a source URL: ${result.sources.withoutUrl}`,
  )
  out(`\nReady offline: ${result.readyOffline ? 'yes' : 'no'}`)
  out(`Not checked here: ${result.notChecked.join('; ')}.`)
}
process.exit(result.readyOffline ? 0 : 1)
