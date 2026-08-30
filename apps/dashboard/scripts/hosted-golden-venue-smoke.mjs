import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '../../..')
const FULL_SHA = /^[0-9a-f]{40}$/u

function fail(code) {
  throw new Error(code)
}

export function parseHostedGoldenVenueArgs(args) {
  const values = new Map()
  const allowed = new Set(['--revision', '--question-key', '--report'])
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!allowed.has(option)) fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }
  const revision = values.get('--revision')
  if (!revision || !FULL_SHA.test(revision)) fail('exact-revision-required')
  return {
    revision,
    questionKey: values.get('--question-key') ?? null,
    report: values.get('--report') ?? null,
  }
}

export function validateHostedHealth(health, policy, revision) {
  if (
    health?.ok !== true ||
    health.deployment?.environment !== 'staging' ||
    health.deployment?.revision !== revision ||
    health.deps?.db !== 'up' ||
    health.deps?.queue !== 'up'
  ) {
    fail('exact-staging-health-rejected')
  }
  for (const [key, expected] of Object.entries(policy.resources)) {
    if (health.deployment.resources?.[key] !== expected) fail(`staging-${key}-identity-mismatch`)
  }
}

export function assessSyntheticAnswer(answer, expectedFacts) {
  const normalized = answer.normalize('NFKC').toLocaleLowerCase('en-US')
  const factMatches = expectedFacts.map((fact) => ({
    fact,
    matched: normalized.includes(fact.normalize('NFKC').toLocaleLowerCase('en-US')),
  }))
  return {
    utf8Bytes: Buffer.byteLength(answer, 'utf8'),
    sha256: createHash('sha256').update(answer).digest('hex'),
    factMatches,
    passed: factMatches.every((item) => item.matched),
  }
}

export function resolveHostedGoldenVenueReportPath(value, revision, questionKey = null) {
  if (questionKey !== null && !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(questionKey))
    fail('unsafe-question-key')
  const mode = questionKey ?? 'read-only'
  const fallback = `artifacts/hosted-golden-venue/${revision}-${mode}.json`
  const resolved = path.resolve(repositoryRoot, value ?? fallback)
  const relative = path.relative(repositoryRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe-report-path')
  if (path.extname(resolved) !== '.json') fail('report-must-be-json')
  return resolved
}

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'))
}

export async function runHostedGoldenVenueSmoke(options, environment = process.env) {
  const policy = (await loadJson('scripts/release-verification-policy.json')).staging
  const fixture = await loadJson('scripts/golden-venue/fixture.json')
  if (fixture.synthetic !== true) fail('golden-venue-must-be-synthetic')
  const outputPath = resolveHostedGoldenVenueReportPath(
    options.report,
    options.revision,
    options.questionKey,
  )
  const question = options.questionKey
    ? fixture.expectedQuestions.find((item) => item.key === options.questionKey)
    : null
  if (options.questionKey && !question) fail('unknown-synthetic-question-key')
  if (question && environment.PATHFINDER_ALLOW_HOSTED_PROVIDER_SMOKE !== '1')
    fail('hosted-provider-smoke-opt-in-required')

  const healthUrl = new URL(policy.healthUrl)
  if (healthUrl.protocol !== 'https:' || healthUrl.hostname !== policy.host)
    fail('staging-policy-origin-invalid')
  const origin = healthUrl.origin
  const healthResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(30_000) })
  if (!healthResponse.ok) fail('staging-health-request-failed')
  validateHostedHealth(await healthResponse.json(), policy, options.revision)

  const consoleErrors = []
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push('console-error')
  })
  page.on('pageerror', () => consoleErrors.push('page-error'))

  const report = {
    schemaVersion: 1,
    kind: 'torchiko-hosted-golden-venue-smoke',
    generatedAt: new Date().toISOString(),
    synthetic: true,
    fixtureId: fixture.fixtureId,
    revision: options.revision,
    origin,
    viewport: { width: 390, height: 844 },
    arrival: null,
    chat: null,
    provider: {
      attempted: Boolean(question),
      questionKey: question?.key ?? null,
      answerEvidence: null,
      status: question ? 'pending' : 'not-requested',
    },
  }

  let failure = null
  try {
    const arrivalResponse = await page.goto(`${origin}/${fixture.venueSlug}`, {
      waitUntil: 'networkidle',
      timeout: 60_000,
    })
    if (arrivalResponse?.status() !== 200) fail('golden-venue-arrival-not-200')
    const heading = await page.getByRole('heading', { name: fixture.venueName }).innerText()
    await page.getByRole('link', { name: /Open your guide/u }).click()
    await page.waitForURL(`**/${fixture.venueSlug}/chat`, { timeout: 30_000 })
    const composer = page.getByRole('textbox', { name: 'Ask a question' })
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    report.arrival = { status: arrivalResponse.status(), heading, navigatedToChat: true }
    report.chat = {
      composerEnabled: await composer.isEnabled(),
      horizontalOverflow: widths.scroll > widths.client,
      consoleErrorCount: consoleErrors.length,
    }
    if (!report.chat.composerEnabled) fail('golden-venue-composer-disabled')
    if (report.chat.horizontalOverflow) fail('golden-venue-horizontal-overflow')
    if (report.chat.consoleErrorCount !== 0) fail('golden-venue-browser-errors')

    if (question) {
      const conversation = page.getByRole('log', { name: /conversation/u })
      const before = await conversation.locator('article').count()
      await composer.fill(question.question)
      await page.getByRole('button', { name: 'Send message' }).click()
      await page.waitForFunction(
        ({ count }) => document.querySelectorAll('[role="log"] article').length >= count + 2,
        { count: before },
        { timeout: 120_000 },
      )
      const messages = await conversation.locator('article').allTextContents()
      const answerEvidence = assessSyntheticAnswer(messages.at(-1) ?? '', question.expectedFacts)
      report.provider.answerEvidence = answerEvidence
      report.provider.status = answerEvidence.passed ? 'passed' : 'failed'
      if (!answerEvidence.passed) fail('hosted-provider-answer-failed-corpus-check')
    }
    report.chat.consoleErrorCount = consoleErrors.length
    if (report.chat.consoleErrorCount !== 0) fail('golden-venue-browser-errors')
  } catch (error) {
    failure = error
    if (report.provider.attempted && report.provider.status === 'pending')
      report.provider.status = 'failed'
  } finally {
    await browser.close()
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `${JSON.stringify({
      status: failure ? 'failed' : 'passed',
      report: path.relative(repositoryRoot, outputPath).replaceAll('\\', '/'),
      revision: options.revision,
      provider: report.provider.status,
    })}\n`,
  )
  if (failure) throw failure
  return report
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    await runHostedGoldenVenueSmoke(parseHostedGoldenVenueArgs(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(
      `Hosted Golden Venue smoke failed: ${error instanceof Error ? error.message : 'unexpected-failure'}\n`,
    )
    process.exitCode = 1
  }
}
