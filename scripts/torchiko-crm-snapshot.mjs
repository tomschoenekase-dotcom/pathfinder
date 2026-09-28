#!/usr/bin/env node
// Local reader for the admin "Download agent snapshot" file. No network access:
// it only reads snapshot JSON files that the platform admin saved to disk.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SNAPSHOT_DIR = 'C:\\Users\\tomsc\\MachineWorkspaces\\torchiko\\crm-snapshots'
export const STALE_AFTER_HOURS = 48
const SNAPSHOT_FILE = /^torchiko-crm-snapshot-.+\.json$/u
const SETTLED_STAGES = new Set(['WON', 'LOST', 'PARKED', 'DO_NOT_CONTACT'])

const USAGE = `Usage: node scripts/torchiko-crm-snapshot.mjs <command> [options]

Commands:
  summary                          Counts and age of the newest snapshot
  candidates [filters]             Organizations matching the filters
  org <id or name fragment>        One organization in full

Filters for candidates:
  --city <name>  --region <code>  --type <text>  --size <S|M|L|...>  --tag <slug>
  --uncontacted  --limit <n> (default 50)

Options:
  --file <path>  Read this snapshot instead of the newest one
  --json         Machine-readable output

Snapshots are read from TORCHIKO_CRM_SNAPSHOT_DIR (default ${DEFAULT_SNAPSHOT_DIR}).
The snapshot is read-only and can be stale: check the mailbox for contact after
its generatedAt before drafting.`

export async function findLatestSnapshot(directory) {
  let entries
  try {
    entries = await readdir(directory)
  } catch {
    throw new Error(`No snapshot folder at ${directory}. Download one from /admin/prospects.`)
  }
  // Names embed a fixed-width UTC timestamp, so lexical order is chronological.
  const newest = entries
    .filter((name) => SNAPSHOT_FILE.test(name))
    .sort()
    .at(-1)
  if (!newest) throw new Error(`No torchiko-crm-snapshot-*.json in ${directory}.`)
  return path.join(directory, newest)
}

export function parseSnapshot(text) {
  const snapshot = JSON.parse(text)
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.organizations)) {
    throw new Error('Unsupported snapshot: expected schemaVersion 1 with organizations.')
  }
  return snapshot
}

export function snapshotAgeHours(snapshot, now = new Date()) {
  return (now.getTime() - new Date(snapshot.generatedAt).getTime()) / 3_600_000
}

export function freshnessLine(snapshot, now = new Date()) {
  const hours = snapshotAgeHours(snapshot, now)
  const rounded = Math.round(hours)
  const age = hours < 1 ? 'under 1 hour' : `${rounded} hour${rounded === 1 ? '' : 's'}`
  const warning =
    hours > STALE_AFTER_HOURS
      ? ` WARNING: older than ${STALE_AFTER_HOURS} hours; ask Tom to download a fresh snapshot.`
      : ''
  return `Snapshot ${snapshot.generatedAt} (${age} old).${warning}`
}

export function isUncontacted(organization) {
  const outreach = organization.outreach
  return (
    !outreach.everContacted &&
    !outreach.doNotContact &&
    outreach.crmDrafts === 0 &&
    outreach.campaigns.length === 0 &&
    outreach.duplicateReview === null &&
    !SETTLED_STAGES.has(organization.stage)
  )
}

function matchesText(value, wanted) {
  return typeof value === 'string' && value.toLowerCase().includes(wanted.toLowerCase())
}

export function filterCandidates(snapshot, filters) {
  const matches = snapshot.organizations.filter((organization) => {
    const places = [organization.headquarters, ...organization.venues]
    if (filters.city && !places.some((place) => matchesText(place.city, filters.city))) return false
    if (
      filters.region &&
      !places.some((place) => place.region?.toLowerCase() === filters.region.toLowerCase())
    ) {
      return false
    }
    if (
      filters.type &&
      !matchesText(organization.type, filters.type) &&
      !organization.venues.some((venue) => matchesText(venue.type, filters.type))
    ) {
      return false
    }
    if (
      filters.size &&
      !organization.venues.some(
        (venue) => venue.estimatedSize?.toLowerCase() === filters.size.toLowerCase(),
      )
    ) {
      return false
    }
    if (filters.tag && !organization.tags.includes(filters.tag)) return false
    if (filters.uncontacted && !isUncontacted(organization)) return false
    return true
  })
  return matches.slice(0, filters.limit)
}

export function findOrganization(snapshot, query) {
  const exact = snapshot.organizations.find((organization) => organization.id === query)
  if (exact) return [exact]
  return snapshot.organizations.filter((organization) => matchesText(organization.name, query))
}

export function summarize(snapshot) {
  const organizations = snapshot.organizations
  return {
    generatedAt: snapshot.generatedAt,
    counts: snapshot.counts,
    uncontacted: organizations.filter(isUncontacted).length,
    everContacted: organizations.filter((organization) => organization.outreach.everContacted)
      .length,
    doNotContact: organizations.filter((organization) => organization.outreach.doNotContact).length,
  }
}

function reachableEmails(organization) {
  return organization.contacts
    .filter((contact) => contact.email && !contact.suppressed)
    .map((contact) => contact.email)
}

function candidateLine(organization) {
  const venue = organization.venues[0]
  const where = [
    venue?.city ?? organization.headquarters.city,
    venue?.region ?? organization.headquarters.region,
  ]
    .filter(Boolean)
    .join(', ')
  const emails = reachableEmails(organization)
  return [
    organization.id,
    organization.name,
    where || '-',
    venue?.type ?? organization.type ?? '-',
    `size ${venue?.estimatedSize ?? '?'}`,
    `stage ${organization.stage ?? '?'}`,
    emails.length ? emails.join(' ') : 'no reachable email',
  ].join(' | ')
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { limit: 50 }
  const positional = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === '--json' || arg === '--uncontacted') {
      options[arg.slice(2)] = true
    } else if (
      ['--city', '--region', '--type', '--size', '--tag', '--limit', '--file'].includes(arg)
    ) {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      options[arg.slice(2)] = arg === '--limit' ? Number.parseInt(value, 10) : value
      index += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1)
    throw new Error('--limit must be a positive integer')
  return { command, positional, options }
}

export async function run(argv, { env = process.env, now = new Date(), write = console.log } = {}) {
  const { command, positional, options } = parseArgs(argv)
  if (!command || command === 'help' || command === '--help') {
    write(USAGE)
    return
  }
  if (!['summary', 'candidates', 'org'].includes(command))
    throw new Error(`Unknown command ${command}\n\n${USAGE}`)

  const file =
    options.file ??
    (await findLatestSnapshot(env.TORCHIKO_CRM_SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR))
  const snapshot = parseSnapshot(await readFile(file, 'utf8'))
  const freshness = freshnessLine(snapshot, now)
  const stale = snapshotAgeHours(snapshot, now) > STALE_AFTER_HOURS

  if (command === 'summary') {
    const summary = summarize(snapshot)
    if (options.json) write(JSON.stringify({ file, stale, ...summary }, null, 2))
    else {
      write(freshness)
      write(`File: ${file}`)
      write(
        `Organizations ${summary.counts.organizations}, venues ${summary.counts.venues}, contacts ${summary.counts.contacts} (${summary.counts.suppressedContacts} suppressed).`,
      )
      write(
        `Uncontacted ${summary.uncontacted}, ever contacted ${summary.everContacted}, do-not-contact ${summary.doNotContact}.`,
      )
    }
    return
  }

  if (command === 'org') {
    if (!positional[0]) throw new Error('org needs an id or name fragment')
    const matches = findOrganization(snapshot, positional[0])
    if (options.json)
      write(JSON.stringify({ generatedAt: snapshot.generatedAt, stale, matches }, null, 2))
    else {
      write(freshness)
      if (!matches.length) write('No match.')
      for (const organization of matches.slice(0, options.limit))
        write(JSON.stringify(organization, null, 2))
    }
    return
  }

  const matches = filterCandidates(snapshot, options)
  if (options.json)
    write(
      JSON.stringify(
        { generatedAt: snapshot.generatedAt, stale, count: matches.length, matches },
        null,
        2,
      ),
    )
  else {
    write(freshness)
    write(`${matches.length} match(es).`)
    for (const organization of matches) write(candidateLine(organization))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
