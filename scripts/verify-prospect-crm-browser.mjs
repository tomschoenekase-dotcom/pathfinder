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
const out = option('--output')
const readback = JSON.parse(await readFile(option('--readback'), 'utf8'))
assert.equal(readback.passed, true)
const base = 'http://127.0.0.1:58618'
const directory = '/dev-fixtures/prospect-research'
await mkdir(out, { recursive: false })
const receipt = {
  schema: 'torchiko.local-crm-browser-acceptance/v1',
  observedAt: new Date().toISOString(),
  base,
  sourceHash: readback.sourceSha256,
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedExternalRequests: [],
  screenshots: [],
  accessibility: [],
  overflow: [],
  browser:
    'isolated headless Microsoft Edge; real native API and shared production components; no authenticated production session',
}
let browser, context, page
const check = (condition, label) => {
  receipt.checks.push({ label, passed: Boolean(condition) })
  assert.ok(condition, label)
}
async function screenshot(name, fullPage = false) {
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage, animations: 'disabled' })
  receipt.screenshots.push(file)
}
async function overflow(label) {
  const result = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('main *')]
      .filter((el) => {
        const b = el.getBoundingClientRect()
        return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1)
      })
      .slice(0, 12)
      .map((el) => ({
        tag: el.tagName,
        text: el.textContent?.slice(0, 80),
        className: String(el.className),
      })),
  }))
  receipt.overflow.push({ label, ...result })
  check(result.document <= result.viewport + 1, `${label}: no page horizontal overflow`)
}
async function axe(label) {
  const report = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze()
  const violations = report.violations.map(({ id, impact, description, nodes }) => ({
    id,
    impact,
    description,
    nodes: nodes.slice(0, 8).map((n) => ({ target: n.target, summary: n.failureSummary })),
  }))
  receipt.accessibility.push({ label, passes: report.passes.length, violations })
  // Retain all violations and continue other journeys before final failure reporting.
  receipt.checks.push({ label: `${label}: accessibility checks`, passed: violations.length === 0 })
}
async function matched(number) {
  await expect(
    page.getByRole('region', { name: 'Prospect results' }).getByRole('status').first(),
  ).toContainText(`${number} matched`, { timeout: 120000 })
  await expect(page.getByRole('region', { name: 'Prospect results' })).toHaveAttribute(
    'aria-busy',
    'false',
    { timeout: 120000 },
  )
}
async function clear() {
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await matched(16725)
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  receipt.browserVersion = browser.version()
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
  page.on('pageerror', (error) => receipt.errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') receipt.consoleErrors.push(message.text().slice(0, 1200))
  })
  const response = await page.goto(base + directory, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  check(response?.ok(), 'local directory server renders successfully')
  await matched(16725)
  check(
    (await page.locator('a[href*="/prospect-research/porg_"]').count()) === 100,
    'first page renders 100 real prospects',
  )
  check(
    (await page
      .getByRole('combobox', { name: 'Territory', exact: true })
      .locator('option')
      .count()) === 86,
    '85 named territories plus all-territory selection',
  )
  await screenshot('directory-desktop')
  await overflow('desktop directory')
  await axe('desktop directory')
  await page.getByRole('button', { name: 'Load 100 more', exact: true }).click()
  await expect(page.locator('a[href*="/prospect-research/porg_"]')).toHaveCount(200)
  await matched(16725)
  const ids = await page
    .locator('a[href*="/prospect-research/porg_"]')
    .evaluateAll((links) => links.map((link) => new URL(link.href).pathname))
  check(
    new Set(ids).size === 200,
    'cursor append retains total count and has no duplicated rendered IDs',
  )
  await page.getByRole('combobox', { name: 'Contact record', exact: true }).selectOption('RECORDED')
  await matched(6183)
  await page.getByRole('combobox', { name: 'Contact record', exact: true }).selectOption('MISSING')
  await matched(10542)
  await clear()
  await page
    .getByRole('combobox', { name: 'Evidence source', exact: true })
    .selectOption('WEB_EVIDENCE')
  await matched(0)
  await page
    .getByRole('combobox', { name: 'Evidence source', exact: true })
    .selectOption('IMPORTED')
  await matched(16725)
  await clear()
  const search = page.getByRole('textbox', { name: 'Search prospects', exact: true })
  await search.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toBeFocused()
  const focus = await page.getByRole('combobox', { name: 'Stage', exact: true }).evaluate((el) => ({
    visible: el.matches(':focus-visible'),
    outline: getComputedStyle(el).outlineStyle,
    width: getComputedStyle(el).outlineWidth,
  }))
  check(focus.visible, 'keyboard focus is visible on native filter controls')
  const territory = page.getByRole('combobox', { name: 'Territory', exact: true })
  await territory.selectOption({ label: 'Chicago Metro' })
  await expect(page.getByRole('region', { name: 'Prospect results' })).toHaveAttribute(
    'aria-busy',
    'false',
  )
  const owner = readback.ownerOnly.find((row) => row.name === 'The Plant') ?? readback.ownerOnly[0]
  await search.fill(owner.name)
  await expect(page.locator(`a[href*="/${owner.organizationId}"]`)).toBeVisible()
  await page.locator(`a[href*="/${owner.organizationId}"]`).click()
  await expect(page.getByRole('heading', { name: owner.name, exact: true, level: 1 })).toBeVisible({
    timeout: 180000,
  })
  await expect(
    page.getByText('No contact recorded. Contact details and permission remain unknown.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByText(`Workbook sheet ${owner.territory}, row ${owner.row}`, { exact: true }),
  ).toBeVisible()
  await page.getByText('View original captured source fields', { exact: true }).first().click()
  await expect(page.locator('pre').first()).toContainText('owner_name')
  await expect(page.locator('pre').first()).toContainText('rawRowSha256')
  await screenshot('detail-owner-only-desktop', true)
  await overflow('desktop owner-only detail')
  await axe('desktop detail')
  await page.getByRole('link', { name: 'Prospect directory', exact: true }).click()
  await expect(search).toHaveValue(owner.name)
  await expect(territory).toHaveValue(/pterritory_/)
  check(page.url().includes('search='), 'detail return restores directory filters')
  await clear()
  await search.fill('NO-MATCH-CRM-ACCEPTANCE-8d02d26d')
  await matched(0)
  await expect(page.getByText(/No prospects match/i)).toBeVisible()
  await clear()
  const failOnce = async (route) =>
    route.fulfill({ status: 503, body: 'Deliberate read-only acceptance outage' })
  await page.route('**/dev-fixtures/prospect-research/data?*', failOnce)
  await search.fill('Museum')
  await expect(page.getByRole('button', { name: 'Retry directory', exact: true })).toBeVisible()
  await screenshot('directory-recoverable-error')
  await page.unroute('**/dev-fixtures/prospect-research/data?*', failOnce)
  await page.getByRole('button', { name: 'Retry directory', exact: true }).click()
  await expect(page.locator('a[href*="/prospect-research/porg_"]').first()).toBeVisible()
  check((await search.inputValue()) === 'Museum', 'read error retry preserves user filters')
  await clear()
  await page.setViewportSize({ width: 375, height: 812 })
  await screenshot('directory-mobile')
  await overflow('375px directory')
  await territory.selectOption({ label: owner.territory })
  await search.fill(owner.name)
  await page.locator(`a[href*="/${owner.organizationId}"]`).click()
  await expect(page.getByRole('heading', { name: owner.name, exact: true, level: 1 })).toBeVisible()
  await screenshot('detail-owner-only-mobile', true)
  await overflow('375px owner detail')
  await page.setViewportSize({ width: 320, height: 812 })
  await overflow('320px owner detail')
  const missing = readback.contactWithoutUrl[0]
  await page.goto(`${base}${directory}/${missing.organizationId}`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(
    page.getByRole('heading', { name: missing.name, exact: true, level: 1 }),
  ).toBeVisible()
  await expect(page.getByText('Source URL not recorded', { exact: true })).toBeVisible()
  await expect(page.getByText(/Email status: Unknown · permission: Unknown/i).first()).toBeVisible()
  await screenshot('detail-missing-source-url-320', true)
  await overflow('320px missing source URL detail')
  await axe('320px detail')
  await page.goto(base + directory)
  await matched(16725)
  await overflow('320px directory')
  const denied = await context.request.get(`${base}${directory}/data`, {
    headers: { Origin: 'https://remote.example' },
  })
  check(denied.status() === 404, 'cross-origin local data request denied')
  const noMutation = await context.request.post(`${base}${directory}/data`, { data: {} })
  check(noMutation.status() === 405, 'read-only adapter does not expose POST')
  check(receipt.errors.length === 0, 'no uncaught JavaScript or hydration errors')
} catch (error) {
  receipt.errors.push(error.stack ?? String(error))
  if (page) {
    try {
      await screenshot('failure-state')
      receipt.failureBody = (await page.locator('body').innerText()).slice(0, 6000)
    } catch {}
  }
} finally {
  receipt.passed = receipt.errors.length === 0 && receipt.checks.every((check) => check.passed)
  receipt.completedAt = new Date().toISOString()
  if (context) await context.close()
  if (browser) await browser.close()
  await writeFile(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  })
  console.log(
    JSON.stringify(
      {
        passed: receipt.passed,
        checks: receipt.checks,
        errors: receipt.errors,
        screenshots: receipt.screenshots,
        accessibility: receipt.accessibility.map((a) => ({
          label: a.label,
          violations: a.violations,
        })),
      },
      null,
      2,
    ),
  )
  if (!receipt.passed) process.exitCode = 1
}
