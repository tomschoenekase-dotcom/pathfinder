import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { default: AxeBuilder } = require('@axe-core/playwright')
const option = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Required: ${name}`)
  return path.resolve(process.argv[index + 1])
}
const output = option('--output')
const native = JSON.parse(await readFile(option('--native-receipt'), 'utf8'))
assert.equal(native.passed, true)
assert.equal(native.mode, 'FULL_LOCAL_NO_SEND')
const base = 'http://127.0.0.1:58618'
const directory = '/dev-fixtures/prospect-research'
await mkdir(output, { recursive: false })
const receipt = {
  schema: 'torchiko.native-sales-browser/1',
  startedAt: new Date().toISOString(),
  base,
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedExternalRequests: [],
  screenshots: [],
  accessibility: [],
  snapshots: [],
  deliveryAvailable: false,
  SEND_AUTHORIZED: false,
  actor: 'local:no-send-operator — not authenticated as Tom',
}
let browser, context, page
const check = (value, label) => {
  receipt.checks.push({ label, passed: Boolean(value) })
  console.log(`${value ? 'PASS' : 'FAIL'} ${label}`)
  assert.ok(value, label)
}
const panel = () => page.getByRole('region', { name: 'Sales preparation and review', exact: true })
const waitReady = async () => {
  await expect(panel()).toBeVisible({ timeout: 180000 })
  await expect(panel()).toHaveAttribute('aria-busy', 'false', { timeout: 180000 })
  await expect(panel().getByRole('alert')).toHaveCount(0)
}
async function snapshot(example, label) {
  const response = await context.request.get(`${base}${directory}/sales?venueId=${example.venueId}`)
  check(response.ok(), `${label}: native readback available`)
  const state = await response.json()
  receipt.snapshots.push({
    label,
    venueId: state.venueId,
    snapshotHash: state.snapshotHash,
    gate: state.gate,
    routing: state.routing,
    outreachState: state.outreachState,
    correspondenceState: state.correspondenceState,
    preparationId: state.preparation?.id,
    draft: state.draft,
    SEND_AUTHORIZED: state.SEND_AUTHORIZED,
  })
  check(
    state.SEND_AUTHORIZED === false && state.senderAvailable === false,
    `${label}: no delivery capability`,
  )
  return state
}
async function screenshot(label, target = panel()) {
  const filename = path.join(output, `${label}.png`)
  await target.screenshot({ path: filename, animations: 'disabled' })
  receipt.screenshots.push(filename)
}
async function noOverflow(label) {
  const value = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    panel: document
      .querySelector('[aria-label="Sales preparation and review"]')
      ?.getBoundingClientRect().width,
  }))
  check(
    value.document <= value.width + 1,
    `${label}: no document overflow (${value.document}/${value.width})`,
  )
}
async function accessibility(label) {
  const result = await new AxeBuilder({ page })
    .include('[aria-label="Sales preparation and review"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  const violations = result.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
  }))
  receipt.accessibility.push({ label, passes: result.passes.length, violations })
  check(violations.length === 0, `${label}: no automated accessibility violations`)
}
async function detail(example) {
  const response = await page.goto(`${base}${directory}/${example.organizationId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  check(response?.ok(), `${example.name}: detail route rendered`)
  await waitReady()
}
try {
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
    if (message.type() === 'error') receipt.consoleErrors.push(message.text().slice(0, 1200))
  })
  const response = await page.goto(base + directory, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  check(response?.ok(), 'Existing native prospect directory loads')
  await expect(page.getByRole('region', { name: 'Prospect results' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 180000 },
  )
  await expect(page.locator('a[href*="/prospect-research/porg_"]').first()).toBeVisible({
    timeout: 180000,
  })
  await page
    .getByRole('textbox', { name: 'Search prospects', exact: true })
    .fill(native.examples.P08.name)
  const link = page.locator(`a[href*="/${native.examples.P08.organizationId}"]`)
  await expect(link).toBeVisible({ timeout: 180000 })
  await screenshot('directory-desktop', page.locator('main'))
  await link.click()
  await waitReady()
  check(page.url().includes(native.examples.P08.organizationId), 'Native list → detail navigation')
  await expect(panel().getByText('ENOUGH EVIDENCE', { exact: true })).toBeVisible()
  await expect(panel().getByText('UNKNOWN / UNKNOWN', { exact: true })).toBeVisible()
  check(
    (await panel().getByRole('button', { name: /^send/i }).count()) === 0,
    'No delivery button exists',
  )
  const initial = await snapshot(native.examples.P08, 'Outreach before browser action')

  // Actual Tab navigation and Enter activation, not only programmatic click coverage.
  await panel().getByRole('button', { name: 'Reload native state', exact: true }).focus()
  let reached = false
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    reached = await panel()
      .getByRole('button', { name: 'Prepare writing context', exact: true })
      .evaluate((el) => document.activeElement === el)
    if (reached) break
  }
  check(reached, 'Keyboard reaches the real preparation action')
  check(
    await panel()
      .getByRole('button', { name: 'Prepare writing context', exact: true })
      .evaluate((el) => el.matches(':focus-visible')),
    'Keyboard focus is visibly indicated',
  )
  await page.keyboard.press('Enter')
  await waitReady()
  await expect(panel().getByText(/Preparation ready for the writer/)).toBeVisible()
  await expect(panel().getByText(/Approved Language: 0 active, 0 selected/)).toBeVisible()
  const body =
    'Hello,\n\nWould it be useful to explore a small visitor guide focused on one room or a few objects you choose? The idea would be to work from the material you want visitors to have, without assuming that a larger rollout is needed.\n\nI would be interested in an appointment to discuss whether that would fit your setting and what a useful starting point might be.\n\nThanks,\nTom'
  await panel().getByLabel('Subject', { exact: true }).fill('A small visitor-guide discussion')
  await panel().getByLabel('Message body', { exact: true }).fill(body)
  await panel().getByRole('button', { name: 'Save review revision', exact: true }).click()
  await waitReady()
  const first = await snapshot(native.examples.P08, 'Outreach saved in browser')
  check(
    first.draft?.body === body && first.draft.state === 'DRAFT_REVIEW',
    'Browser saves exact subject/body into native review',
  )
  await panel().getByRole('button', { name: 'Mark exact revision reviewed', exact: true }).focus()
  await page.keyboard.press('Enter')
  await waitReady()
  const reviewed = await snapshot(native.examples.P08, 'Outreach reviewed in browser')
  check(
    reviewed.draft?.state === 'REVIEWED_NO_SEND' && reviewed.draft.id === first.draft.id,
    'Keyboard review binds the exact same revision without approval',
  )
  await screenshot('outreach-reviewed-desktop')
  await noOverflow('1440px outreach detail')
  await accessibility('Desktop review')
  await panel()
    .getByLabel('Message body', { exact: true })
    .fill(body.replace('I would be interested', 'I would be glad'))
  await expect(
    panel().getByRole('button', { name: 'Mark exact revision reviewed', exact: true }),
  ).toBeDisabled()
  await panel().getByRole('button', { name: 'Save review revision', exact: true }).click()
  await waitReady()
  const revised = await snapshot(native.examples.P08, 'Changed browser revision')
  check(
    revised.draft.id !== first.draft.id &&
      revised.draft.version === first.draft.version + 1 &&
      revised.draft.previousDraftId === first.draft.id,
    'Edited reviewed body creates a linked immutable revision',
  )
  check(
    revised.snapshotHash === initial.snapshotHash,
    'Draft/review actions did not rewrite native source/contact identity',
  )

  await detail(native.examples.P02)
  await expect(
    panel().getByText('SYNTHETIC correspondence. No venue sent these fixture messages.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    panel().getByText('Could we start with just one room?', { exact: true }),
  ).toBeVisible()
  await panel()
    .getByLabel(/Intended response to the latest inbound point/)
    .fill(
      'We could discuss one room using material the venue chooses; ask which room would be useful to explore. This is a discussion, not a delivery promise.',
    )
  await panel().getByRole('button', { name: 'Prepare writing context', exact: true }).click()
  await waitReady()
  const replyBody =
    'Hi,\n\nWe could discuss starting with one room and focusing on the material you would choose for it. That would give us a specific setting to talk through, rather than starting with a much broader idea.\n\nWhich room would you most like to explore first, and what would you want a visitor to take away from it?\n\nThanks,\nTom'
  await panel().getByLabel('Subject', { exact: true }).fill('Re: A small visitor guide')
  await panel().getByLabel('Message body', { exact: true }).fill(replyBody)
  await panel().getByRole('button', { name: 'Save review revision', exact: true }).click()
  await waitReady()
  const replyState = await snapshot(
    native.examples.P02,
    'Synthetic response prepared and saved in browser',
  )
  check(
    replyState.correspondenceState === 'RESPONSE_REVIEW_NEEDED' &&
      replyState.draft.body === replyBody,
    'Native synthetic thread → reducer → Composer reply → response review UX',
  )
  check(
    !replyState.draft.body.includes('Could we start with just one room?') &&
      !replyState.draft.body.includes('From:'),
    'Response is not a copied transcript',
  )
  await screenshot('synthetic-response-desktop')
  await page.setViewportSize({ width: 375, height: 812 })
  await noOverflow('375px synthetic response detail')
  await screenshot('synthetic-response-narrow')
  await accessibility('375px response review')
  await page.setViewportSize({ width: 320, height: 812 })
  await noOverflow('320px synthetic response detail')

  await detail(native.examples.RESEARCH)
  await expect(panel().getByText('RESEARCH REQUIRED', { exact: true })).toBeVisible()
  await expect(
    panel().getByRole('button', { name: 'Prepare writing context', exact: true }),
  ).toBeDisabled()
  const research = await snapshot(native.examples.RESEARCH, 'Bounded research surface')
  check(
    research.gate.questions.length > 0 && research.gate.questions.length <= 4,
    'Exact bounded research questions are visible',
  )
  await screenshot('research-required-320')
  await noOverflow('320px research-required detail')

  await detail(native.examples.HOLD)
  await expect(panel().getByText('HUMAN INPUT REQUIRED', { exact: true })).toBeVisible()
  await expect(
    panel().getByText('Held / suppressed — preparation blocked', { exact: true }),
  ).toBeVisible()
  for (const name of [
    'Prepare writing context',
    'Save review revision',
    'Mark exact revision reviewed',
  ])
    await expect(panel().getByRole('button', { name, exact: true })).toBeDisabled()
  await screenshot('native-suppression-320')
  await noOverflow('320px native suppression detail')
  await accessibility('320px held state')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await detail(native.examples.P06)
  const form = await snapshot(native.examples.P06, 'Form route')
  check(
    form.routing.kind === 'contact_form' && form.routing.nativeContactId === null,
    'Form route is not presented as an email recipient',
  )
  await screenshot('form-route-desktop')

  const denied = await context.request.post(`${base}${directory}/sales`, {
    data: {
      action: 'prepare',
      input: { venueId: native.examples.P08.venueId, expectedSnapshotHash: revised.snapshotHash },
    },
  })
  check(denied.status() === 404, 'Mutation without same-origin/CSRF authority denied')
  const crossOrigin = await context.request.get(
    `${base}${directory}/sales?venueId=${native.examples.P08.venueId}`,
    { headers: { Origin: 'https://remote.invalid' } },
  )
  check(crossOrigin.status() === 404, 'Cross-origin sales read denied')
  const sender = await context.request.post(`${base}${directory}/sales`, {
    headers: { Origin: base, 'X-Torchiko-No-Send': '1' },
    data: { action: 'send', input: {} },
  })
  check(sender.status() === 400, 'No HTTP sender action exists')
  const originalReadOnly = await context.request.post(`${base}${directory}/data`, { data: {} })
  check(originalReadOnly.status() === 405, 'Original data endpoint remains read-only')
  check(receipt.errors.length === 0, 'No uncaught browser or hydration errors')
} catch (error) {
  receipt.errors.push(error.stack ?? String(error))
  if (page) {
    try {
      await screenshot('failure-state', page.locator('body'))
      receipt.failureBody = (await page.locator('body').innerText()).slice(0, 7000)
    } catch {}
  }
} finally {
  receipt.passed = receipt.errors.length === 0 && receipt.checks.every((entry) => entry.passed)
  receipt.completedAt = new Date().toISOString()
  if (context) await context.close()
  if (browser) await browser.close()
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  })
  console.log(
    JSON.stringify(
      {
        passed: receipt.passed,
        checks: receipt.checks.length,
        errors: receipt.errors,
        screenshotCount: receipt.screenshots.length,
        accessibility: receipt.accessibility,
        output,
      },
      null,
      2,
    ),
  )
  if (!receipt.passed) process.exitCode = 1
}
