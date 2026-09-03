import { parseBoundedLogLines } from './staging-runtime-audit.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/u
const SHA = /^[0-9a-f]{40}$/u
const WINDOWS = new Set(['24h', '48h', '72h', '96h', '120h', '144h', '168h'])
const MAX_DEPLOYMENTS = 8
const MAX_LOG_LINES = 1000

export class FounderAbsenceHistoryAuditError extends Error {
  constructor(code) {
    super(code)
    this.name = 'FounderAbsenceHistoryAuditError'
    this.code = code
  }
}

function fail(code) {
  throw new FounderAbsenceHistoryAuditError(code)
}

function utcDay(value) {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail('invalid-observation-date')
  }
  return date
}

function previousUtcDay(value) {
  const date = utcDay(value)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function parseFounderAbsenceLogLines(text) {
  if (typeof text !== 'string') fail('invalid-log-output')
  const lines = text.split(/\r?\n/u).filter(Boolean)
  if (lines.length > MAX_LOG_LINES) fail('invalid-log-output')
  try {
    return parseBoundedLogLines(text)
  } catch {
    fail('invalid-log-output')
  }
}

export function parseFounderAbsenceHistoryArgs(args) {
  const deployments = []
  let since = null
  let expectedRevision = null
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (typeof value !== 'string') fail('invalid-options')
    if (option === '--deployment' && UUID.test(value)) {
      deployments.push(value)
      continue
    }
    if (option === '--since' && WINDOWS.has(value) && since === null) {
      since = value
      continue
    }
    if (option === '--expected-revision' && SHA.test(value) && expectedRevision === null) {
      expectedRevision = value
      continue
    }
    fail('invalid-options')
  }
  if (
    deployments.length === 0 ||
    deployments.length > MAX_DEPLOYMENTS ||
    new Set(deployments).size !== deployments.length ||
    since === null ||
    expectedRevision === null
  ) {
    fail('invalid-options')
  }
  return { deployments, expectedRevision, since }
}

export function buildFounderAbsenceHistoryQueries({ deployments, expectedRevision, since }) {
  if (
    !Array.isArray(deployments) ||
    deployments.length === 0 ||
    deployments.length > MAX_DEPLOYMENTS ||
    new Set(deployments).size !== deployments.length ||
    deployments.some((deployment) => !UUID.test(deployment)) ||
    !SHA.test(expectedRevision ?? '') ||
    !WINDOWS.has(since)
  ) {
    fail('invalid-options')
  }
  return deployments.map((deployment) => ({
    deployment,
    args: [
      'logs',
      deployment,
      '--service',
      'staging-workers',
      '--environment',
      'staging',
      '--since',
      since,
      '--lines',
      '1000',
      '--json',
    ],
  }))
}

export function auditFounderAbsenceHistory(options, runRailway) {
  if (typeof runRailway !== 'function') fail('invalid-runner')
  const relevant = []
  for (const query of buildFounderAbsenceHistoryQueries(options)) {
    const result = runRailway(query.args)
    if (
      result === null ||
      typeof result !== 'object' ||
      result.status !== 0 ||
      typeof result.stdout !== 'string'
    ) {
      fail('railway-query-failed')
    }
    for (const row of parseFounderAbsenceLogLines(result.stdout)) {
      if (
        row.action === 'workers.founder-absence-observation.retained' ||
        row.action === 'workers.founder-absence-observation.failed'
      ) {
        relevant.push({ deployment: query.deployment, row })
      }
    }
  }

  const failedEvents = relevant.filter(
    ({ row }) => row.action === 'workers.founder-absence-observation.failed',
  ).length
  if (failedEvents > 0) fail('founder-absence-capture-failed')

  const days = new Map()
  for (const { deployment, row } of relevant) {
    if (row.action !== 'workers.founder-absence-observation.retained') continue
    if (
      typeof row.observedOn !== 'string' ||
      !DATE.test(row.observedOn) ||
      typeof row.evidenceComplete !== 'boolean' ||
      typeof row.releaseSha !== 'string' ||
      !SHA.test(row.releaseSha)
    ) {
      fail('invalid-observation-row')
    }
    utcDay(row.observedOn)
    const existing = days.get(row.observedOn)
    if (existing) {
      if (
        existing.evidenceComplete !== row.evidenceComplete ||
        existing.releaseSha !== row.releaseSha
      ) {
        fail('observation-identity-drift')
      }
      existing.events += 1
      existing.deployments.add(deployment)
      continue
    }
    days.set(row.observedOn, {
      observedOn: row.observedOn,
      evidenceComplete: row.evidenceComplete,
      releaseSha: row.releaseSha,
      events: 1,
      deployments: new Set([deployment]),
    })
  }
  if (days.size === 0) fail('no-founder-absence-observations')

  const ordered = [...days.values()].sort((left, right) =>
    left.observedOn.localeCompare(right.observedOn),
  )
  const latestDay = ordered.at(-1)
  const streakReleaseSha = latestDay.evidenceComplete ? latestDay.releaseSha : null
  const streakMatchesExpectedRevision = streakReleaseSha === options.expectedRevision
  let consecutiveCompleteDays = streakReleaseSha === null ? 0 : 1
  for (let index = ordered.length - 1; consecutiveCompleteDays > 0 && index > 0; index -= 1) {
    const current = ordered[index]
    const previous = ordered[index - 1]
    if (
      !previous.evidenceComplete ||
      previous.releaseSha !== streakReleaseSha ||
      previous.observedOn !== previousUtcDay(current.observedOn)
    )
      break
    consecutiveCompleteDays += 1
  }

  return {
    ok: true,
    environment: 'staging',
    window: options.since,
    expectedRevision: options.expectedRevision,
    deployments: options.deployments,
    retainedEvents: relevant.length,
    failedEvents: 0,
    observedDays: ordered.map((day) => ({
      observedOn: day.observedOn,
      evidenceComplete: day.evidenceComplete,
      releaseSha: day.releaseSha,
      events: day.events,
      deployments: [...day.deployments].sort(),
    })),
    streakReleaseSha,
    streakMatchesExpectedRevision,
    consecutiveCompleteDays,
    sevenDayReviewReady: streakMatchesExpectedRevision && consecutiveCompleteDays >= 7,
    certificationGranted: false,
    launchGate: false,
  }
}
