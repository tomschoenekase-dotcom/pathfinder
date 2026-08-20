import { readFile } from 'node:fs/promises'

const fixtureUrl = new URL('./fixture.json', import.meta.url)
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'))
const required = [
  'client',
  'venue',
  'onboarding',
  'upload-intake',
  'review',
  'content-package-eval',
  'release',
  'guest-retrieval-chat',
  'feedback',
  'report',
  'support',
  'update',
  'export-offboarding',
]
const failures = [
  'provider-outage',
  'rate-limit',
  'bad-upload',
  'duplicate-request',
  'failed-worker',
  'report-failure',
  'ambiguous-provider-outcome',
]
if (fixture.schemaVersion !== 1 || fixture.synthetic !== true)
  throw new Error('Golden Venue fixture must be versioned and synthetic')
if (
  new Set(fixture.requiredPhases).size !== required.length ||
  required.some((phase) => !fixture.requiredPhases.includes(phase))
)
  throw new Error('Golden Venue lifecycle coverage is incomplete')
if (failures.some((failure) => !fixture.failureInjections.includes(failure)))
  throw new Error('Golden Venue failure coverage is incomplete')
if (
  !Array.isArray(fixture.expectedQuestions) ||
  fixture.expectedQuestions.length < 3 ||
  fixture.expectedQuestions.some((entry) => !entry.question || !entry.expectedFacts?.length)
)
  throw new Error('Golden Venue expected-answer evidence is incomplete')
console.log(
  `Golden Venue fixture validated: ${fixture.fixtureId}; ${required.length} phases; ${failures.length} failure injections.`,
)
