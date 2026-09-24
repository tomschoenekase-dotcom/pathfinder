import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { default: AxeBuilder } = require('@axe-core/playwright')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argument = (name) => {
  const index = process.argv.indexOf(name)
  assert.ok(index >= 0 && process.argv[index + 1], `Required argument ${name}`)
  return path.resolve(process.argv[index + 1])
}
const output = argument('--output')
assert.ok(
  output.startsWith(path.join(root, 'artifacts/crm-meaning-review-20260921-r001') + path.sep),
)
const native = JSON.parse(await readFile(argument('--native-receipt'), 'utf8'))
assert.equal(native.passed, true)
assert.equal(native.mode, 'FULL_LOCAL_NO_SEND')
await mkdir(output, { recursive: false })
const base = 'http://127.0.0.1:58618',
  directory = '/dev-fixtures/prospect-research'
const receipt = {
  schema: 'torchiko.native-meaning-browser/1',
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  consoleErrors: [],
  screenshots: [],
  accessibility: [],
  snapshots: [],
  blockedExternalRequests: [],
  resourceSamples: [],
  SEND_AUTHORIZED: false,
  actor: { type: 'SYSTEM', id: 'synthetic:crm-meaning:local-operator', authenticatedHuman: false },
  desktopTool:
    'observe unavailable (-32602); real installed Edge desktop-sized and narrow browser exercised instead',
}
const exec = promisify(execFile)
let browser, context, page
const panel = () => page.getByRole('region', { name: 'Sales preparation and review', exact: true })
const claims = () => panel().getByRole('region', { name: 'Claim and meaning review', exact: true })
const check = (condition, label) => {
  receipt.checks.push({ label, passed: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  assert.ok(condition, label)
}
async function resources(label) {
  const result = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '$os=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{FreeDiskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3);FreeRamGiB=[math]::Round($os.FreePhysicalMemory/1MB,3)}|ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 20000 },
  )
  const data = JSON.parse(result.stdout.trim())
  receipt.resourceSamples.push({ label, ...data })
  check(
    data.FreeDiskGiB >= 5,
    `${label}: 5 GiB disk reserve preserved (${data.FreeDiskGiB} GiB free)`,
  )
}
async function ready() {
  await expect(panel()).toBeVisible({ timeout: 180000 })
  await expect(panel()).toHaveAttribute('aria-busy', 'false', { timeout: 180000 })
  await expect(panel().getByRole('alert')).toHaveCount(0)
}
async function snap(example, label) {
  const response = await context.request.get(`${base}${directory}/sales?venueId=${example.venueId}`)
  check(response.ok(), `${label}: native readback available`)
  const view = await response.json()
  receipt.snapshots.push({ label, ...view })
  check(
    view.SEND_AUTHORIZED === false && view.senderAvailable === false,
    `${label}: SEND AUTHORIZED: NO`,
  )
  return view
}
async function clickAction(name, action) {
  const button = panel().getByRole('button', { name, exact: true })
  await expect(button).toBeEnabled({ timeout: 10000 })
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${directory}/sales`) &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === action,
    { timeout: 180000 },
  )
  const [response] = await Promise.all([responsePromise, button.click()])
  const body = await response.json()
  check(response.ok(), `${action}: real UI action succeeds${body.error ? ': ' + body.error : ''}`)
  await ready()
  return body
}
async function save(text) {
  await panel().getByLabel('Subject', { exact: true }).fill(text.subject)
  await panel().getByLabel('Message body', { exact: true }).fill(text.body)
  return clickAction('Save review revision', 'save')
}
async function assess(reference, mode = 'good') {
  const buttons = claims().getByRole('button', { name: /^Inspect claim \d+$/ })
  check(
    (await buttons.count()) === reference.annotations.length,
    `${mode}: every exact subject/body span is inspectable`,
  )
  for (let index = 0; index < reference.annotations.length; index++) {
    const annotation = reference.annotations[index],
      assessment = reference.assessments[index]
    await claims()
      .getByRole('button', { name: `Inspect claim ${index + 1}`, exact: true })
      .click()
    await claims().getByLabel('Claim category', { exact: true }).selectOption(annotation.category)
    await claims()
      .getByLabel('Attributed verdict', { exact: true })
      .selectOption(assessment.verdict)
    const sources = claims().getByRole('checkbox', { name: /^Evidence / })
    for (let source = 0; source < (await sources.count()); source++) {
      const box = sources.nth(source),
        name = await box.getAttribute('aria-label')
      await box.setChecked(annotation.claim_ids.includes(name.slice('Evidence '.length)))
    }
    const answers = claims().getByRole('checkbox', { name: /^Answers / })
    for (let answer = 0; answer < (await answers.count()); answer++) {
      const box = answers.nth(answer)
      if (await box.isEnabled())
        await box.setChecked(
          mode === 'reply' && annotation.section === 'body' && annotation.category !== 'NONFACTUAL',
        )
    }
    await claims()
      .getByLabel('Reason for this mapping and assessment', { exact: true })
      .fill(
        mode === 'unsupported' && annotation.category === 'SOURCE FACT'
          ? 'SYNTHETIC adversarial review: this intentionally wrong supported verdict must not bless an invented exhibit, price or visit.'
          : assessment.reason,
      )
  }
  await claims().getByLabel('Reviewer type', { exact: true }).selectOption('model')
  await claims()
    .getByLabel('Reviewer identity / attribution', { exact: true })
    .fill('GPT-6 Astra Pro — SYNTHETIC real-browser acceptance assessment')
  return clickAction('Record claim / meaning findings', 'meaning')
}
async function screenshot(name, target = claims()) {
  const destination = path.join(output, `${name}.png`)
  await target.screenshot({ path: destination, animations: 'disabled', timeout: 90000 })
  receipt.screenshots.push(destination)
}
async function a11y(label) {
  const result = await new AxeBuilder({ page })
    .include('[aria-label="Sales preparation and review"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
  }))
  receipt.accessibility.push({ label, passes: result.passes.length, violations })
  check(violations.length === 0, `${label}: no automated accessibility violations`)
}
async function noOverflow(label) {
  const measured = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }))
  check(
    measured.document <= measured.width + 1,
    `${label}: no horizontal document overflow (${measured.document}/${measured.width})`,
  )
}
async function detail(example) {
  const response = await page.goto(`${base}${directory}/${example.organizationId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  check(response?.ok(), `${example.name}: actual native detail rendered`)
  await ready()
}

try {
  await resources('Before the one owned browser')
  browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-first-run',
    ],
  })
  receipt.browserVersion = browser.version()
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  })
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (/^https?:/iu.test(url) && new URL(url).origin !== base) {
      receipt.blockedExternalRequests.push(url.split('?')[0])
      return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(90000)
  page.on('pageerror', (error) => receipt.errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') receipt.consoleErrors.push(message.text().slice(0, 2000))
  })
  const directoryResponse = await page.goto(base + directory, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  check(directoryResponse?.ok(), 'Existing native prospect directory loads')
  await expect(page.getByRole('region', { name: 'Prospect results' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 180000 },
  )
  await page
    .getByRole('textbox', { name: 'Search prospects', exact: true })
    .fill(native.examples.P03.name)
  const link = page.locator(`a[href*="/${native.examples.P03.organizationId}"]`)
  await expect(link).toBeVisible({ timeout: 180000 })
  await link.click()
  await ready()
  check(
    page.url().includes(native.examples.P03.organizationId),
    'Prospect directory → native detail → sales review navigation',
  )
  const initial = await snap(native.examples.P03, 'Before browser review')
  await panel().getByRole('button', { name: 'Reload native state', exact: true }).focus()
  let reached = false
  for (let index = 0; index < 45; index++) {
    await page.keyboard.press('Tab')
    reached = await panel()
      .getByRole('button', { name: 'Prepare writing context', exact: true })
      .evaluate((element) => element === document.activeElement)
    if (reached) break
  }
  check(reached, 'Keyboard Tab reaches preparation with a visible focus target')
  check(
    await panel()
      .getByRole('button', { name: 'Prepare writing context', exact: true })
      .evaluate((element) => element.matches(':focus-visible')),
    'Keyboard preparation target has a visible focus indicator',
  )
  const keyboardResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${directory}/sales`) &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.action === 'prepare',
  )
  await page.keyboard.press('Enter')
  check((await keyboardResponse).ok(), 'Keyboard Enter prepares source context')
  await ready()
  check(
    (await snap(native.examples.P03, 'Prepared in browser')).preparation.approvedCount === 0,
    'Actual UI preparation retains zero approved-language entries',
  )
  const pieces = native.goodText.body.split('\n\n')
  pieces[1] = 'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.'
  await save({ subject: native.goodText.subject, body: pieces.join('\n\n') })
  await claims().getByRole('button', { name: 'Inspect claim 3', exact: true }).click()
  await claims().getByText('Source details: F-VENUE', { exact: true }).click()
  check(
    (await claims()
      .getByText(/Evidence SHA-256:/)
      .count()) > 0,
    'Factual claim inspection exposes source pointer, content and exact hash',
  )
  await screenshot('unsupported-claim-inspection-desktop')
  let unsupported = await assess(native.goodAnnotations, 'unsupported')
  check(
    unsupported.claimReview.status === 'BLOCKED' &&
      unsupported.claimReview.current.findings.some(
        (entry) => entry.code === 'UNSUPPORTED_PERSONALIZATION_DETAIL',
      ),
    'Real UI records unsupported exhibit-price-visit findings, even under a wrong supported model verdict',
  )
  await expect(claims().getByTestId('meaning-status')).toHaveText('BLOCKED')
  unsupported = await clickAction('Mark exact revision reviewed', 'review')
  check(
    unsupported.draft.state === 'REVIEWED_NO_SEND' && unsupported.claimReview.status === 'BLOCKED',
    'Read-review click leaves claim/meaning holds in place',
  )
  await screenshot(
    'recorded-unsupported-findings-desktop',
    claims().getByRole('region', { name: 'Recorded meaning findings' }),
  )

  let good = await save(native.goodText)
  check(
    good.claimReview.status === 'REQUIRED' &&
      good.claimReview.history.some(
        (entry) => entry.draftId === unsupported.draft.id && !entry.applicable,
      ),
    'Changed exact draft invalidates prior meaning review without rewriting history',
  )
  good = await assess(native.goodAnnotations)
  check(
    good.claimReview.status === 'ASSESSED_NO_SEND' && !good.claimReview.readReviewRecorded,
    'Real UI records a source-supported assessment without fabricating read-review',
  )
  good = await clickAction('Mark exact revision reviewed', 'review')
  check(
    good.draft.state === 'REVIEWED_NO_SEND' && good.claimReview.status === 'ASSESSED_NO_SEND',
    'Native UI reaches reviewed-no-send with separate meaning review',
  )
  check(
    good.claimReview.current.recordedBy.type === 'SYSTEM' &&
      good.claimReview.current.recordedBy.synthetic,
    'Recorded UI actions remain explicitly synthetic SYSTEM, not Tom or authenticated human actions',
  )
  await claims().getByText('Exact source and recipient binding', { exact: true }).click()
  await claims().getByText('Recorded claim-to-source evidence', { exact: true }).click()
  await screenshot('source-bound-reviewed-desktop')
  await a11y('Desktop meaning review')
  await noOverflow('1440px meaning review')
  await page.setViewportSize({ width: 375, height: 812 })
  await noOverflow('375px meaning review')
  await a11y('375px meaning review')
  await screenshot('source-bound-reviewed-narrow')
  await page.setViewportSize({ width: 320, height: 812 })
  await noOverflow('320px meaning review')
  await screenshot(
    'recorded-evidence-320',
    claims().getByRole('region', { name: 'Recorded meaning findings' }),
  )
  await resources('After desktop and narrow proof')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel()
    .getByLabel('Subject', { exact: true })
    .fill('Could a focused visitor guide be useful?')
  await expect(
    panel().getByRole('button', { name: 'Mark exact revision reviewed', exact: true }),
  ).toBeDisabled()
  await expect(
    claims().getByRole('button', { name: 'Record claim / meaning findings', exact: true }),
  ).toBeDisabled()
  check(true, 'Editing reviewed text immediately disables both read-review and meaning recording')
  let revised = await clickAction('Save review revision', 'save')
  check(
    revised.draft.id !== good.draft.id &&
      revised.claimReview.status === 'REQUIRED' &&
      !revised.claimReview.history.some((entry) => entry.applicable),
    'Saving changed reviewed subject requires a fresh exact assessment',
  )
  revised = await assess(native.goodAnnotations)
  revised = await clickAction('Mark exact revision reviewed', 'review')
  check(
    revised.draft.state === 'REVIEWED_NO_SEND' && revised.claimReview.status === 'ASSESSED_NO_SEND',
    'Changed revision can complete a fresh independent reviewed-no-send journey',
  )
  check(
    initial.snapshotHash === revised.snapshotHash,
    'Source/contact fingerprint is unchanged throughout the real UI draft/review journey',
  )
  await snap(native.examples.P03, 'Completed outreach review')

  await detail(native.examples.P02)
  const beforeReply = await snap(
    native.examples.P02,
    'Reply fixture before current ordinary-turn setup',
  )
  if (!beforeReply.gate.canPrepare) {
    check(
      beforeReply.blocker?.includes('Correspondence owner holds preparation') &&
        beforeReply.correspondence?.issues.includes('MULTIPLE_UNANSWERED_INBOUND_MESSAGES'),
      'Prior changed-inbound test left a genuine multiple-unanswered hold; no production hold is bypassed',
    )
    const fixtureOutput = path.join(output, 'synthetic-dialogue-setup.json')
    const fixture = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        path.join(root, 'scripts/run-local-crm-research.ps1'),
        '-Mode',
        'meaning-check',
        '--advance-synthetic-dialogue',
        '--output',
        fixtureOutput,
      ],
      { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    )
    await writeFile(
      path.join(output, 'synthetic-dialogue-setup.log'),
      fixture.stdout + fixture.stderr,
      { flag: 'wx' },
    )
    check(
      JSON.parse(await readFile(fixtureOutput, 'utf8')).passed,
      'Explicit local dialogue fixture creates an ordinary reply test case without a human action or provider send',
    )
    await panel().getByRole('button', { name: 'Reload native state', exact: true }).click()
    await ready()
  }
  await panel().getByLabel('Intended response to the latest inbound point').fill(native.answerText)
  await clickAction('Prepare writing context', 'prepare')
  await save(native.replyText)
  let reply = await assess(native.replyAnnotations, 'reply')
  check(
    reply.claimReview.status === 'ASSESSED_NO_SEND' &&
      reply.claimReview.current.answers.length === reply.claimReview.questions.length,
    'Actual reply UI maps answers to the latest inbound evidence',
  )
  reply = await clickAction('Mark exact revision reviewed', 'review')
  check(
    !reply.draft.body.includes(reply.correspondence.latestInbound.body) &&
      !/^\s*(From:|>)/imu.test(reply.draft.body),
    'Reply body contains a new response, not a dumped email chain',
  )
  await screenshot('reply-evidence-desktop')
  const appendReceipt = path.join(output, 'changed-inbound-native.json')
  const append = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-File',
      path.join(root, 'scripts/run-local-crm-research.ps1'),
      '-Mode',
      'meaning-check',
      '--append-inbound',
      '--output',
      appendReceipt,
    ],
    { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  )
  await writeFile(path.join(output, 'changed-inbound-native.log'), append.stdout + append.stderr, {
    flag: 'wx',
  })
  check(
    JSON.parse(await readFile(appendReceipt, 'utf8')).passed,
    'Guarded native acceptance appended changed synthetic inbound evidence',
  )
  await panel().getByRole('button', { name: 'Reload native state', exact: true }).click()
  await ready()
  const stale = await snap(native.examples.P02, 'Changed inbound shown in browser')
  check(
    stale.claimReview.status === 'STALE' &&
      stale.draft.state === 'STALE' &&
      stale.snapshotHash !== reply.snapshotHash,
    'Actual browser reload displays stale draft and meaning review after changed inbound',
  )
  await expect(claims().getByTestId('meaning-status')).toHaveText('STALE')
  await expect(
    claims().getByRole('button', { name: 'Record claim / meaning findings', exact: true }),
  ).toBeDisabled()
  await page.setViewportSize({ width: 375, height: 812 })
  await screenshot('changed-inbound-stale-narrow')
  await noOverflow('375px stale reply')
  await a11y('375px stale reply')
  await detail(native.examples.P06)
  const form = await snap(native.examples.P06, 'Form route inspection')
  check(
    form.routing.kind === 'contact_form' &&
      form.claimReview.boundIdentity.recipientValue === form.routing.value,
    'UI binds a form URL rather than inventing an email recipient',
  )
  check(
    (await panel()
      .getByRole('button', { name: /^send|approve/i })
      .count()) === 0,
    'No sender or approval button exists',
  )
  const denied = await context.request.post(`${base}${directory}/sales`, {
    data: { action: 'meaning', input: {} },
  })
  check(denied.status() === 404, 'Unqualified HTTP mutation denied by local authority boundary')
  const send = await context.request.post(`${base}${directory}/sales`, {
    headers: { Origin: base, 'X-Torchiko-No-Send': '1' },
    data: { action: 'send', input: {} },
  })
  check(send.status() === 400, 'HTTP API has no send operation')
  const human = await context.request.post(`${base}${directory}/sales`, {
    headers: { Origin: base, 'X-Torchiko-No-Send': '1' },
    data: {
      action: 'meaning',
      input: {
        venueId: form.venueId,
        draftId: form.draft.id,
        contentHash: form.draft.contentHash,
        expectedSnapshotHash: form.snapshotHash,
        expectedBindingHash: form.claimReview.bindingHash,
        expectedMeaningReviewId: form.claimReview.current?.id ?? null,
        annotations: native.goodAnnotations.annotations,
        assessments: native.goodAnnotations.assessments,
        languageUses: [],
        answers: [],
        unsupportedClaims: [],
        reviewer: { kind: 'human', identity: 'Tom' },
      },
    },
  })
  check(human.status() === 403, 'Local synthetic browser route cannot fabricate human review')
  await resources('Before closing the owned browser')
  check(receipt.errors.length === 0, 'No uncaught JavaScript or hydration error')
} catch (error) {
  receipt.errors.push(error.stack ?? String(error))
  if (page) {
    try {
      await screenshot('failure-state', page.locator('body'))
      receipt.failureBody = (await page.locator('body').innerText()).slice(0, 16000)
    } catch {}
  }
} finally {
  if (context) await context.close()
  if (browser) await browser.close()
  receipt.ownedBrowserClosed = true
  receipt.completedAt = new Date().toISOString()
  receipt.passed = receipt.errors.length === 0 && receipt.checks.every((entry) => entry.passed)
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  })
  console.log(
    JSON.stringify(
      {
        output,
        passed: receipt.passed,
        checks: receipt.checks.length,
        errors: receipt.errors,
        screenshots: receipt.screenshots.length,
        accessibility: receipt.accessibility,
      },
      null,
      2,
    ),
  )
  if (!receipt.passed) process.exitCode = 1
}
