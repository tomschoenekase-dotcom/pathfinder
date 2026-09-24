import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, 'artifacts/crm-first-send-20260921-r001')
const require = createRequire(new URL('../apps/dashboard/package.json', import.meta.url))
const { chromium, expect } = require('@playwright/test')
const { default: AxeBuilder } = require('@axe-core/playwright')
const exec = promisify(execFile)
const arg = (key, fallback = '') => {
  const i = process.argv.indexOf(key)
  return i < 0 ? fallback : process.argv[i + 1]
}
const phase = arg('--phase', 'export'),
  which = arg('--target', 'all')
assert.ok(['export', 'import', 'handoff', 'readback', 'negative', 'workspace'].includes(phase))
const output = path.resolve(arg('--output'))
const qa = process.env.TORCHIKO_CONNECTED_QA_DIR
  ? path.resolve(process.env.TORCHIKO_CONNECTED_QA_DIR) : null
const under = (file, directory) => directory && (file === directory || file.startsWith(directory + path.sep))
assert.ok(output.startsWith(artifacts + path.sep) || (qa && output.startsWith(qa + path.sep)))
const resultDirectory = path.resolve(arg('--results', qa ?? artifacts))
assert.ok(under(resultDirectory, artifacts) || under(resultDirectory, qa))
const stagedPath = path.resolve(arg('--staged', path.join(artifacts, 'stage-r001.json')))
assert.ok(under(stagedPath, artifacts) || under(stagedPath, qa))
const staged = JSON.parse(await readFile(stagedPath, 'utf8'))
assert.equal(staged.synthetic, true)
assert.equal(staged.liveSend, false)
assert.ok(staged.ids.venueId.startsWith('SYN-CRM-FIRSTSEND-VENUE-'))
const targets = [
  {
    key: 'synthetic',
    name: 'SYNTHETIC First Send Fixture Museum',
    organizationId: staged.ids.organizationId,
    venueId: staged.ids.venueId,
  },
  { key: 'pilot', name: 'Evanston History Center', ...staged.originals['Evanston History Center'] },
  {
    key: 'nonpilot',
    name: 'Centralia Historical Society Museum',
    ...staged.originals['Centralia Historical Society Museum'],
  },
].filter((t) => which === 'all' || which === t.key)
assert.ok(targets.length)
await mkdir(output, { recursive: false })
const base = 'http://127.0.0.1:58618',
  dir = '/dev-fixtures/prospect-research'
const receipt = {
  schema: 'torchiko.first-send-real-browser/1',
  phase,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  consoleErrors: [],
  screenshots: [],
  tasks: [],
  snapshots: [],
  accessibility: [],
  resources: [],
  blockedExternal: [],
  actor: { type: 'SYSTEM', id: 'synthetic:crm-meaning:local-operator', notTom: true },
  liveSend: false,
}
let browser, context, page
let failBrowser
const browserFailure = new Promise((_resolve, reject) => { failBrowser = reject })
// A compile/hydration failure is terminal evidence, not a reason to wait for a missing panel.
browserFailure.catch(() => {})
const panel = () => page.getByRole('region', { name: 'Sales preparation and review', exact: true })
const writer = () => panel().getByRole('region', { name: 'AI writer roundtrip', exact: true })
const operational = () =>
  panel().getByRole('region', { name: 'Operational candidate handoff', exact: true })
const check = (ok, label) => {
  receipt.checks.push({ label, passed: Boolean(ok) })
  console.log((ok ? 'PASS ' : 'FAIL ') + label)
  assert.ok(ok, label)
}
async function capacity(label) {
  const r = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '$os=Get-CimInstance Win32_OperatingSystem;[pscustomobject]@{ramGiB=[math]::Round($os.FreePhysicalMemory/1MB,3);diskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3)}|ConvertTo-Json -Compress',
    ],
    { windowsHide: true, timeout: 20000 },
  )
  const value = JSON.parse(r.stdout)
  receipt.resources.push({ label, ...value })
  check(value.diskGiB >= 5 && value.ramGiB >= 4, label + ': disk>=5 GiB and RAM>=4 GiB')
}
async function ready(allowError = false) {
  await Promise.race([
    expect(panel()).toHaveAttribute('aria-busy', 'false', { timeout: 180000 }),
    browserFailure,
  ])
  if (!allowError) await expect(panel().getByRole('alert')).toHaveCount(0)
}
async function load(target) {
  const hydratedRead = page.waitForResponse(r => r.url().includes(dir + '/data?') && r.request().method() === 'GET', { timeout: 90000 })
  const response = await page.goto(base + dir, { waitUntil: 'domcontentloaded', timeout: 180000 })
  check(response.ok(), 'Original native prospect directory loads')
  await hydratedRead
  await expect(page.getByRole('region', { name: 'Prospect results', exact: true })).toHaveAttribute('aria-busy', 'false')
  await page.getByRole('textbox', { name: 'Search prospects', exact: true }).fill(target.name)
  await expect(page.getByRole('textbox', { name: 'Search prospects', exact: true })).toHaveValue(target.name)
  await page.locator(`a[href*="/${target.organizationId}"]`).click()
  await ready()
  check(
    page.url().includes(target.organizationId),
    target.key + ': directory to original native detail',
  )
}
async function snapshot(target, label) {
  const r = await context.request.get(`${base}${dir}/sales?venueId=${target.venueId}`)
  check(r.ok(), label + ': exact native readback')
  const view = await r.json()
  receipt.snapshots.push({ target: target.key, label, view })
  check(
    view.SEND_AUTHORIZED === false &&
      view.senderAvailable === false &&
      view.operational.liveSendAvailable === false,
    label + ': original native NO-SEND and no live dispatcher',
  )
  return view
}
async function action(name, kind, expectedSuccess = true) {
  const b = panel().getByRole('button', { name, exact: true })
  await expect(b).toBeEnabled({ timeout: 15000 })
  const wait = page.waitForResponse(
    (r) =>
      r.url().endsWith(dir + '/sales') &&
      r.request().method() === 'POST' &&
      r.request().postDataJSON()?.action === kind,
    { timeout: 180000 },
  )
  const [r] = await Promise.all([wait, b.click()])
  const body = await r.json()
  check(
    r.ok() === expectedSuccess,
    `${kind}: real UI ${expectedSuccess ? 'accepted' : 'held'}${body.error ? ' — ' + body.error : ''}`,
  )
  await ready(!expectedSuccess)
  return body
}
async function shot(label, target = writer()) {
  const p = path.join(output, label + '.png')
  await target.screenshot({ path: p, animations: 'disabled', timeout: 90000 })
  receipt.screenshots.push(p)
}
async function viewport(width) {
  await page.setViewportSize({ width, height: 1000 })
  const size = await page.evaluate(() => ({
    width: innerWidth,
    content: document.documentElement.scrollWidth,
  }))
  check(size.content <= size.width + 1, `${width}px has no horizontal document overflow`)
}
async function accessibility(label, selector = '[aria-label="Sales preparation and review"]') {
  const r = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  const violations = r.violations.map(({ id, impact, nodes }) => ({
    id,
    impact,
    nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
  }))
  receipt.accessibility.push({ label, violations })
  check(!violations.length, label + ': no automated accessibility violations')
}
try {
  await capacity('Before owned browser')
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
    acceptDownloads: true,
  })
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (/^https?:/i.test(url) && new URL(url).origin !== base) {
      receipt.blockedExternal.push(url.split('?')[0])
      return route.abort()
    }
    return route.continue()
  })
  page = await context.newPage()
  page.setDefaultTimeout(60000)
  page.on('pageerror', (e) => {
    receipt.errors.push(e.message)
    failBrowser(new Error('Browser compilation or hydration failed: ' + e.message))
  })
  page.on('console', (m) => {
    if (m.type() === 'error') receipt.consoleErrors.push(m.text().slice(0, 1000))
  })
  if (phase === 'import' && process.argv.includes('--lose-first-response')) {
    let dropped = false
    await context.route(`${base}${dir}/sales`, async (route) => {
      const request = route.request()
      if (!dropped && request.method() === 'POST' && request.postDataJSON()?.action === 'importWriterResult') {
        const committed = await route.fetch()
        const value = await committed.json()
        if (!committed.ok() || !value.writerImportReceipt?.id) {
          receipt.failedImportResponse = { status: committed.status(), error: value.error ?? 'Missing immutable receipt' }
          return route.fulfill({ response: committed })
        }
        check(true, 'Real import committed before its response was lost')
        receipt.lostResponseReceiptId = value.writerImportReceipt.id
        dropped = true
        return route.abort('failed')
      }
      return route.fallback()
    })
  }
  for (const target of targets) {
    await viewport(1440)
    if (phase === 'workspace') {
      assert.equal(target.key, 'synthetic', 'Only explicit synthetic workspace selections are permitted')
      const missing = 'SYN-CRM-FIRSTSEND-ORG-r999999999'
      let mutations = 0
      page.on('request', (request) => {
        if (request.url().includes(dir) && request.method() !== 'GET') mutations++
      })
      const denied = await context.request.get(`${base}${dir}/workspace/data?organizationId=porg_aaaaaaaaaaaaaaaaaaaaaaaa`)
      check(denied.status() === 404, 'Workspace fixture refuses normal CRM organization IDs')
      const missingRead = await context.request.get(`${base}${dir}/workspace/data?organizationId=${missing}`)
      check(missingRead.status() === 404, 'Explicit missing synthetic peer is absent in the actual database')
      const url = `${base}${dir}/workspace?organizationId=${target.organizationId}&organizationId=${missing}`
      check((await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })).ok(), 'Real selected workspace page loads')
      await page.getByRole('button', { name: 'Open selected synthetic records', exact: true }).click()
      const workspace = page.getByRole('region', { name: 'Selected-record preparation', exact: true })
      await expect(workspace.getByRole('heading', { level: 3 })).toHaveCount(2)
      await expect(workspace.getByText('loading', { exact: true })).toHaveCount(0)
      const current = await snapshot(target, 'Workspace current native state')
      check((await workspace.innerText()).includes(current.snapshotHash), 'Workspace displays the exact current native snapshot')
      await expect(workspace.getByText('missing organization', { exact: true })).toBeVisible()
      check((await workspace.innerText()).includes('2/10 selected'), 'One missing record remains a separate held peer')
      const reload = workspace.getByRole('button', { name: 'Reload native state', exact: true }).first()
      await page.keyboard.press('Tab')
      await reload.focus()
      check(await reload.evaluate(el => document.activeElement === el && el.matches(':focus-visible')), 'Workspace reload has visible keyboard focus')
      await page.keyboard.press('Enter')
      await expect(workspace.getByText('loading', { exact: true })).toHaveCount(0)
      for (const width of [1440, 768, 375, 320]) {
        await viewport(width)
        await shot(`synthetic-workspace-${width}`, workspace)
        await accessibility(`Selected workspace ${width}`, '[aria-labelledby="preparation-workspace-title"]')
      }
      const storage = await page.evaluate(() => sessionStorage.getItem('torchiko.prospect-preparation-workspace.v1'))
      check(Boolean(storage) && !/"(?:body|writerMarkdown|writerContext|text)"\s*:/u.test(storage), 'Workspace session stores references without message or guide bodies')
      receipt.workspaceSession = { schema: JSON.parse(storage).schema, selected: JSON.parse(storage).ids,
        containsBodies: false }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 })
      await page.getByRole('button', { name: 'Reopen retained synthetic selection', exact: true }).click()
      await expect(workspace.getByRole('heading', { level: 3 })).toHaveCount(2)
      await expect(workspace.getByText('loading', { exact: true })).toHaveCount(0)
      await expect(workspace.getByText('missing organization', { exact: true })).toBeVisible()
      check((await workspace.innerText()).includes(current.snapshotHash), 'Reopen rereads current native state and keeps the held peer')
      check(mutations === 0, 'Selection, reload and reopen made no mutation request')
      receipt.workspaceLimitations = 'Real native read/render/reopen proof only; authenticated saved-guide preparation and imported-result recovery are covered separately at their actual proof levels.'
      continue
    }
    await load(target)
    let view = await snapshot(target, 'Before ' + phase)
    if (phase === 'export') {
      if (view.correspondence?.latestInbound) {
        await panel()
          .getByLabel('Intended response to the latest inbound point', { exact: true })
          .fill(
            'We could discuss starting with one room and material the venue chooses. No staff setup-time estimate has been established. Ask which room and which existing material they would want to use before discussing an estimate. Do not promise delivery, timing or a price.',
          )
      }
      view = await action('Prepare writing context', 'prepare')
      check(
        view.writerTask && !view.preparation.stale,
        target.key + ': current persisted preparation yields exact writer task',
      )
      const downloadButton = writer().getByRole('button', { name: 'Download current writer task' })
      await downloadButton.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      check(
        await downloadButton.evaluate(
          (el) => document.activeElement === el && el.matches(':focus-visible'),
        ),
        'Keyboard focus reaches writer export',
      )
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.keyboard.press('Enter'),
      ])
      const filename = path.join(output, `${target.key}-task.json`)
      await download.saveAs(filename)
      const task = JSON.parse(await readFile(filename, 'utf8'))
      check(
        task.taskId === view.writerTask.taskId && task.binding.venueId === target.venueId,
        'Downloaded actual UI task preserves exact current identity',
      )
      receipt.tasks.push({
        target: target.key,
        filename,
        taskId: task.taskId,
        preparationId: task.binding.preparationId,
        synthetic: task.writerContext.synthetic,
      })
      await shot(target.key + '-task-export-desktop')
    } else if (phase === 'import' || phase === 'negative') {
      const filename = path.join(resultDirectory, `${target.key}-result.json`)
      const result = JSON.parse(await readFile(filename, 'utf8'))
      await writer().getByLabel('AI result JSON file', { exact: true }).setInputFiles(filename)
      await expect(
        writer().getByRole('button', { name: 'Import exact AI candidate' }),
      ).toBeEnabled()
      await shot(target.key + '-import-preview-desktop')
      if (phase === 'import' && process.argv.includes('--lose-first-response')) {
        await writer().getByRole('button', { name: 'Import exact AI candidate' }).click()
        await expect(panel().getByRole('alert')).toBeVisible()
        await expect(writer().getByRole('button', { name: 'Import exact AI candidate' })).toBeEnabled()
        check(Boolean(receipt.lostResponseReceiptId), 'Lost response preserves the exact result for operator retry')
      }
      const after = await action(
        'Import exact AI candidate',
        'importWriterResult',
        phase !== 'negative',
      )
      if (phase === 'negative') {
        check(
          typeof after.error === 'string',
          'Stale/forged result has a visible hold, not a refreshed task',
        )
        await shot(target.key + '-result-rejected', panel())
        const unchanged = await snapshot(target, 'After rejected result')
        check(
          unchanged.draft?.id === view.draft?.id,
          'Rejected result does not create a partial native draft',
        )
        continue
      }
      view = after
      check(
        view.draft.subject === result.subject && view.draft.body === result.body,
        'Exact foreground model text returned through UI without transcription',
      )
      check(
        view.draft.writerAttribution?.generatedBy === result.generatedBy.identity &&
          view.draft.writerAttribution.submittedBy === 'synthetic:crm-meaning:local-operator',
        'Generation and submitting operator remain distinct',
      )
      check(
        view.claimReview.current?.annotations.length === result.annotations.length,
        'Exact annotations were imported automatically, not manually rebuilt',
      )
      receipt.importedAssessmentState = view.claimReview.status
      check(
        view.claimReview.status === 'ASSESSED_NO_SEND' && !view.claimReview.stale,
        'Original meaning owner records applicable attributed assessment',
      )
      check(
        view.claimReview.readReviewRecorded === false,
        'Import did not manufacture read acknowledgment or human approval',
      )
      const draftId = view.draft.id,
        meaningId = view.claimReview.current.id
      await writer().getByLabel('AI result JSON file', { exact: true }).setInputFiles(filename)
      const retry = await action('Import exact AI candidate', 'importWriterResult')
      check(
        retry.draft.id === draftId && retry.claimReview.current.id === meaningId,
        'Identical UI retry is zero duplicate draft/assessment rows',
      )
      const meaning = panel().getByRole('region', { name: 'Claim and meaning review', exact: true })
      const factual = result.annotations.find((a) => a.category === 'SOURCE FACT')
      if (factual) {
        const index = result.annotations.indexOf(factual)
        await meaning
          .getByRole('button', { name: `Inspect claim ${index + 1}`, exact: true })
          .click()
        for (const claim of factual.claim_ids) {
          const details = meaning.getByText(`Source details: ${claim}`, { exact: true })
          if (await details.count()) await details.click()
        }
      }
      await shot(target.key + '-imported-source-meaning-desktop', meaning)
      await accessibility(target.key + ' desktop import')
      await viewport(768)
      await shot(target.key + '-writer-tablet')
      await viewport(375)
      await shot(target.key + '-writer-narrow')
      await accessibility(target.key + ' narrow import')
      await viewport(320)
      await shot(target.key + '-meaning-320', meaning)
    } else if (phase === 'handoff') {
      assert.equal(
        target.key,
        'synthetic',
        'No real venue campaign or synthetic human action is allowed',
      )
      check(
        view.operational.rehearsal && view.claimReview.status === 'ASSESSED_NO_SEND',
        'Only isolated synthetic origin is selected for operational rehearsal',
      )
      const section = operational()
      const summary = section.getByText(
        'Select this exact reviewed message for a new operational candidate',
        { exact: true },
      )
      if (!(await summary.evaluate((el) => el.parentElement.open))) await summary.click()
      await section
        .getByLabel('Existing delivery account', { exact: true })
        .selectOption(staged.ids.accountId)
      await section
        .getByLabel('Single-prospect campaign name', { exact: true })
        .fill('SYNTHETIC first-send foreground ' + Date.now())
      view = await action('Create separate operational candidate', 'handoffOperational')
      const candidate = view.operational.candidate
      check(
        candidate.synthetic &&
          candidate.status === 'NEEDS_REVIEW' &&
          candidate.sourceDraftId === view.draft.id &&
          candidate.id !== view.draft.id,
        'Existing campaign owner created a NEW operational candidate; original NO-SEND revision is unchanged',
      )
      for (const flag of candidate.escalationFlags)
        await section.getByLabel(`Acknowledge exact escalation: ${flag}`, { exact: true }).check()
      view = await action('Record synthetic exact approval', 'reviewOperational')
      check(
        view.operational.candidate.approvedBy === 'synthetic:crm-meaning:local-operator',
        'Approval is explicitly a SYSTEM rehearsal fixture, not Tom',
      )
      view = await action('Freeze this one-recipient batch', 'stageOperational')
      check(
        view.operational.candidate.batch.count === 1,
        'Existing owner freezes the exact one-recipient count and content',
      )
      view = await action('Approve synthetic frozen count and content', 'approveOperationalBatch')
      await shot('synthetic-frozen-exact-approval', section)
      view = await action('Release to isolated FAKE outbox', 'releaseSyntheticBatch')
      check(
        view.operational.candidate.batch.outboxId &&
          view.operational.candidate.batch.providerMessageId === null,
        'Outbox release is not provider acceptance or a sent email',
      )
      await viewport(375)
      await shot('synthetic-fake-outbox-narrow', section)
      await accessibility('Synthetic outbox narrow')
    } else {
      assert.equal(target.key, 'synthetic')
      await shot('synthetic-provider-and-correspondence-desktop', operational())
      if (view.operational.candidate?.batch?.deliveryState === 'SENT')
        check(
          Boolean(view.operational.candidate.batch.providerMessageId),
          'Actual FAKE acceptance is shown with retained provider identity',
        )
      if (view.suppression.blocked)
        check(
          !view.gate.canPrepare && !view.writerTask,
          'Opt-out visibly holds further preparation, writing and handoff',
        )
      await viewport(375)
      await shot('synthetic-correspondence-narrow', operational())
      await accessibility('Canonical correspondence narrow')
    }
    await snapshot(target, 'After ' + phase)
  }
  check(receipt.errors.length === 0, 'No uncaught browser/hydration errors')
  receipt.passed = true
} catch (error) {
  receipt.passed = false
  receipt.errors.push(error.stack ?? String(error))
  process.exitCode = 1
  if (page) {
    try {
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      receipt.screenshots.push(path.join(output, 'failure.png'))
    } catch {}
  }
} finally {
  if (browser) await browser.close()
  receipt.ownedBrowserClosed = true
  receipt.completedAt = new Date().toISOString()
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), {
    flag: 'wx',
  })
  console.log(
    JSON.stringify({
      output,
      phase,
      passed: receipt.passed,
      checks: receipt.checks.length,
      errors: receipt.errors,
    }),
  )
}
