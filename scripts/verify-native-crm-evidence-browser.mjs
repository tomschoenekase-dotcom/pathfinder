import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { default: AxeBuilder } = require('@axe-core/playwright')
const exec = promisify(execFile)
const arg = (name) => {
  const i = process.argv.indexOf(name)
  assert.ok(i >= 0 && process.argv[i + 1])
  return path.resolve(process.argv[i + 1])
}
const output = arg('--output')
assert.ok(
  output.startsWith(path.join(root, 'artifacts/crm-evidence-admission-20260921-r001') + path.sep),
)
const staged = JSON.parse(await readFile(arg('--native-receipt'), 'utf8'))
assert.equal(staged.passed, true)
await mkdir(output, { recursive: false })
const base = 'http://127.0.0.1:58618',
  dir = '/dev-fixtures/prospect-research'
const receipt = {
  schema: 'torchiko.native-evidence-browser/1',
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  consoleErrors: [],
  screenshots: [],
  accessibility: [],
  snapshots: [],
  blockedExternalRequests: [],
  resources: [],
  actor: { type: 'SYSTEM', id: 'synthetic:crm-meaning:local-operator', authenticatedHuman: false },
  DesktopControl: 'observe -32602 not found; actual installed Edge used',
  SEND_AUTHORIZED: false,
}
let browser, context, page
const panel = () => page.getByRole('region', { name: 'Sales preparation and review', exact: true })
const evidence = () =>
  panel().getByRole('region', { name: 'Native evidence admission', exact: true })
const meanings = () =>
  panel().getByRole('region', { name: 'Claim and meaning review', exact: true })
const check = (ok, label) => {
  receipt.checks.push({ label, passed: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  assert.ok(ok, label)
}
const ready = async () => {
  await expect(panel()).toHaveAttribute('aria-busy', 'false', { timeout: 180000 })
  await expect(panel().getByRole('alert')).toHaveCount(0)
}
async function resources(label) {
  const result = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '$os=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{diskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3);ramGiB=[math]::Round($os.FreePhysicalMemory/1MB,3)}|ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 20000 },
  )
  const value = JSON.parse(result.stdout)
  receipt.resources.push({ label, ...value })
  check(value.diskGiB >= 5, label + ': disk reserve >=5 GiB')
}
async function snapshot(label) {
  const response = await context.request.get(`${base}${dir}/sales?venueId=${staged.target.venueId}`)
  check(response.ok(), label + ': native readback available')
  const view = await response.json()
  receipt.snapshots.push({ label, ...view })
  check(
    view.SEND_AUTHORIZED === false && view.senderAvailable === false,
    label + ': SEND AUTHORIZED NO',
  )
  return view
}
async function action(name, kind, keyboard = false) {
  const target = panel().getByRole('button', { name, exact: true })
  await expect(target).toBeEnabled({ timeout: 15000 })
  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().endsWith(`${dir}/sales`) &&
      r.request().method() === 'POST' &&
      r.request().postDataJSON()?.action === kind,
    { timeout: 180000 },
  )
  const [response] = await Promise.all([
    responsePromise,
    keyboard ? page.keyboard.press('Enter') : target.click(),
  ])
  const body = await response.json()
  check(response.ok(), `${kind}: real UI action ${body.error ?? 'succeeded'}`)
  await ready()
  return body
}
async function admit(route = 'N-EMAIL', description = true) {
  await evidence().getByLabel('Admit claim N-IDENTITY', { exact: true }).setChecked(true)
  await evidence().getByLabel('Admit claim N-DESCRIPTION', { exact: true }).setChecked(description)
  await evidence().getByLabel('Selected public route', { exact: true }).selectOption(route)
  return action('Admit selected evidence for review', 'admitEvidence')
}
const draftText = (unsupported) => ({
  subject: 'Could a small visitor guide be useful?',
  body: `Hi,\n\n${unsupported ? 'Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.' : staged.target.name + '.'}\n\nWould it be useful to explore a small question-based guide for one room or a few objects? It could use material you choose and stay focused on that part of a visit.\n\nWould a short conversation about that idea make sense?\n\nThanks,\nTom`,
})
async function save(unsupported = false) {
  const text = draftText(unsupported)
  await panel().getByLabel('Subject', { exact: true }).fill(text.subject)
  await panel().getByLabel('Message body', { exact: true }).fill(text.body)
  return action('Save review revision', 'save')
}
async function meaning(unsupported = false) {
  const spans = [draftText(unsupported).subject, ...draftText(unsupported).body.split('\n\n')]
  check(
    (await meanings()
      .getByRole('button', { name: /^Inspect claim \d+$/ })
      .count()) === spans.length,
    'Every exact draft span has an inspection control',
  )
  for (let i = 0; i < spans.length; i++) {
    const quote = spans[i],
      courtesy = ['Hi,', 'Thanks,\nTom'].includes(quote)
    const factual = quote === staged.target.name + '.' || quote.startsWith('Your Moon Gem')
    const category = courtesy ? 'NONFACTUAL' : factual ? 'SOURCE FACT' : 'SALES HYPOTHESIS'
    const ids = courtesy
      ? []
      : factual
        ? ['N-IDENTITY']
        : quote.startsWith('Would a short conversation')
          ? ['H-ASK']
          : ['H-SCOPE']
    await meanings()
      .getByRole('button', { name: `Inspect claim ${i + 1}`, exact: true })
      .click()
    await meanings().getByLabel('Claim category', { exact: true }).selectOption(category)
    await meanings()
      .getByLabel('Attributed verdict', { exact: true })
      .selectOption(courtesy ? 'nonfactual' : factual ? 'supported' : 'hypothetical')
    const sources = meanings().getByRole('checkbox', { name: /^Evidence / })
    for (let j = 0; j < (await sources.count()); j++) {
      const box = sources.nth(j),
        name = await box.getAttribute('aria-label')
      await box.setChecked(ids.includes(name.slice(9)))
    }
    await meanings()
      .getByLabel('Reason for this mapping and assessment', { exact: true })
      .fill(
        courtesy
          ? 'An ordinary greeting or closing asserts no venue fact.'
          : factual
            ? 'The captured native identity supports only the venue name. Any added exhibit, price or completed visit is a deliberately unsupported adversarial test.'
            : 'This is a conditional proposal or question from task direction, not a commitment or established venue need.',
      )
  }
  await meanings()
    .getByLabel('Reviewer identity / attribution', { exact: true })
    .fill('GPT-6 Astra Pro — explicitly synthetic browser acceptance assessment, not Tom')
  return action('Record claim / meaning findings', 'meaning')
}
async function shot(name, locator = evidence()) {
  const filename = path.join(output, name + '.png')
  await locator.screenshot({ path: filename, animations: 'disabled' })
  receipt.screenshots.push(filename)
}
async function layout(width) {
  await page.setViewportSize({ width, height: 1000 })
  const size = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
  }))
  check(size.document <= size.width + 1, `${width}px: no horizontal document overflow`)
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
  receipt.accessibility.push({ label, violations, passes: result.passes.length })
  check(!violations.length, label + ': no automated accessibility violations')
}
try {
  await resources('Before preview browser')
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
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  })
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (/^https?:/i.test(url) && new URL(url).origin !== base) {
      receipt.blockedExternalRequests.push(url.split('?')[0])
      return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', (e) => receipt.errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') receipt.consoleErrors.push(m.text().slice(0, 1000))
  })
  const response = await page.goto(base + dir, { timeout: 180000, waitUntil: 'domcontentloaded' })
  check(response.ok(), 'Original native prospect directory loads')
  await expect(page.getByRole('region', { name: 'Prospect results' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 180000 },
  )
  await page
    .getByRole('textbox', { name: 'Search prospects', exact: true })
    .fill(staged.target.name)
  await page.locator(`a[href*="/${staged.target.organizationId}"]`).click()
  await ready()
  check(
    page.url().includes(staged.target.organizationId),
    'Existing prospect → native evidence review navigation',
  )
  let view = await snapshot('Before task admission')
  check(
    view.evidenceAdmission.captures.length > 0,
    'Native genuine capture is available without pilot identity',
  )
  check(
    !view.gate.canPrepare || Boolean(view.evidenceAdmission.selectionId),
    'No implicit preparation authority from a retained capture',
  )
  receipt.initiallyMissingEvidence = !view.evidenceAdmission.selectionId && !view.gate.canPrepare
  await evidence().getByText('Captured source provenance', { exact: true }).click()
  await evidence().getByText('Capture support: N-IDENTITY', { exact: true }).click()
  await shot('native-capture-before-admission-desktop')
  await evidence().getByLabel('Admit claim N-IDENTITY', { exact: true }).setChecked(true)
  await evidence().getByLabel('Admit claim N-DESCRIPTION', { exact: true }).setChecked(true)
  await evidence().getByLabel('Selected public route', { exact: true }).selectOption('N-EMAIL')
  await evidence()
    .getByLabel('Proposal / task direction, not a source fact', { exact: true })
    .focus()
  await page.keyboard.press('Tab')
  check(
    await evidence()
      .getByRole('button', { name: 'Admit selected evidence for review', exact: true })
      .evaluate((el) => document.activeElement === el && el.matches(':focus-visible')),
    'Keyboard reaches admission with visible focus',
  )
  view = await action('Admit selected evidence for review', 'admitEvidence', true)
  check(
    view.gate.canPrepare && view.sourceState === 'NATIVE_SOURCE_CATALOG_WITH_EXACT_IMPORT_LINEAGE',
    'Actual native nonpilot admission passes original Research Gate',
  )
  check(
    view.routing.value === 'cenhis@socket.net' &&
      view.contacts.every((c) => c.readiness === 'UNKNOWN' && c.permission === 'UNKNOWN'),
    'Published matching route retained; original readiness and permission unchanged',
  )
  view = await action('Prepare writing context', 'prepare')
  check(
    view.preparation.approvedCount === 0 && view.preparation.selectedCount === 0,
    'Actual WLT preparation has zero approved-language entries',
  )
  await save(true)
  view = await meaning(true)
  check(
    view.claimReview.status === 'BLOCKED',
    'Original Composer blocks invented exhibit, price and completed-visit claims',
  )
  await shot('unsupported-native-claim-held', meanings())
  view = await action('Mark exact revision reviewed', 'review')
  check(
    view.claimReview.status === 'BLOCKED' &&
      view.claimReview.current.findings.length > 0 &&
      view.SEND_AUTHORIZED === false,
    'Read acknowledgment cannot grant meaning approval',
  )
  const badId = view.draft.id
  view = await save()
  check(
    view.draft.id !== badId && view.claimReview.status === 'REQUIRED',
    'Corrected text creates a new immutable revision without copied assessment',
  )
  view = await meaning()
  check(
    view.claimReview.status === 'ASSESSED_NO_SEND',
    'Actual source-bound meaning assessment passes with no human certification',
  )
  await panel().getByRole('button', { name: 'Mark exact revision reviewed', exact: true }).focus()
  view = await action('Mark exact revision reviewed', 'review', true)
  check(
    view.draft.state === 'REVIEWED_NO_SEND' &&
      view.claimReview.current.recordedBy.type === 'SYSTEM',
    'Native UI completes reviewed-no-send using explicit synthetic SYSTEM attribution',
  )
  await meanings().getByText('Recorded claim-to-source evidence', { exact: true }).click()
  await shot('native-reviewed-no-send-desktop', meanings())
  await a11y('1440px complete review')
  const reviewedId = view.claimReview.current.id
  await layout(768)
  await layout(375)
  await shot('native-evidence-narrow')
  await a11y('375px native evidence')
  await layout(320)
  await shot('native-meaning-320', meanings())
  await layout(375)
  view = await admit('N-EMAIL', false)
  check(
    view.draft.state === 'STALE' &&
      view.claimReview.stale &&
      view.claimReview.history.some((r) => r.id === reviewedId && !r.applicable),
    'Changed source selection invalidates the prior meaning review without rewriting history',
  )
  await shot('changed-source-stale-review', meanings())
  view = await admit('N-FORM', false)
  check(
    view.routing.kind === 'contact_form' &&
      view.routing.value === 'https://centraliamomuseum.org/contact-us/',
    'Native form admission preserves exact URL rather than manufacturing email',
  )
  await action('Prepare writing context', 'prepare')
  await save()
  await shot('form-route-evidence-narrow')
  view = await admit('', false)
  check(
    !view.gate.canPrepare && view.routing.value === null,
    'Unresolved public routing is visibly held',
  )
  await expect(
    panel().getByRole('button', { name: 'Prepare writing context', exact: true }),
  ).toBeDisabled()
  await a11y('375px unresolved evidence')
  await admit('N-EMAIL', true)
  await action('Prepare writing context', 'prepare')
  await save()
  await meaning()
  view = await action('Mark exact revision reviewed', 'review')
  check(
    view.draft.state === 'REVIEWED_NO_SEND',
    'Fresh independent preparation and review after changed evidence completes correctly',
  )
  await snapshot('Final native evidence review')
  check(
    (await panel()
      .getByRole('button', { name: /^send|approve|crawl|fetch/i })
      .count()) === 0,
    'No sender, approval or network-executor button exists',
  )
  const denied = await context.request.post(`${base}${dir}/sales`, {
    data: { action: 'admitEvidence', input: {} },
  })
  check(denied.status() === 404, 'HTTP admission without same-origin authority is denied')
  for (const action of ['capture', 'send']) {
    const result = await context.request.post(`${base}${dir}/sales`, {
      headers: { Origin: base, 'X-Torchiko-No-Send': '1' },
      data: { action, input: {} },
    })
    check(result.status() === 400, `HTTP has no ${action} operation`)
  }
  await resources('After native evidence browser journey')
  check(!receipt.errors.length, 'No uncaught browser or hydration errors')
} catch (error) {
  receipt.errors.push(error.stack ?? String(error))
  if (page)
    try {
      await shot('failure-state', page.locator('body'))
      receipt.failureBody = (await page.locator('body').innerText()).slice(0, 18000)
    } catch {}
} finally {
  try {
    if (context) await context.close()
    if (browser) await browser.close()
    receipt.ownedBrowserClosed = true
  } catch (error) {
    receipt.errors.push(String(error))
    receipt.ownedBrowserClosed = false
  }
  receipt.passed =
    receipt.checks.length > 0 && receipt.checks.every((c) => c.passed) && !receipt.errors.length
  receipt.completedAt = new Date().toISOString()
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
    flag: 'wx',
  })
  console.log(
    JSON.stringify({
      output,
      passed: receipt.passed,
      checks: receipt.checks.length,
      errors: receipt.errors,
      screenshots: receipt.screenshots.length,
    }),
  )
  if (!receipt.passed) process.exitCode = 1
}
