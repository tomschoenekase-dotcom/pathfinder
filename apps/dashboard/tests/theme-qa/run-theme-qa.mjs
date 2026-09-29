// Consumer-facing visual QA sweep for the visitor chat guide themes/customization.
//
// This is a standalone script (not a `playwright test` spec) so it can drive an
// ad-hoc matrix of fixture URLs against an already-running dev server and dump
// screenshots + a results.json for a human to review. Run with:
//
//   node tests/theme-qa/run-theme-qa.mjs
//
// from apps/dashboard, with the apps/web dev server already listening on
// PLAYWRIGHT_BASE_URL (defaults to http://127.0.0.1:3292).

import { chromium, webkit } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3292'
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const QA_DIR =
  process.env.THEME_QA_DIR ??
  `C:/Users/tomsc/MachineWorkspaces/torchiko/20260928-citypass-app-kit/qa/theme-qa-${timestamp}`
const SCREENSHOT_DIR = path.join(QA_DIR, 'screenshots')

const LOOKS = ['plain', 'bubbles', 'labels', 'photo', 'photo-labels', 'no-more']
const MODES = ['classic', 'character']
const CONVERSATIONS_FOR_MATRIX = ['long', 'reference']

const VIEWPORTS = [
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
]

const BROWSERS = [
  { name: 'chromium', launcher: chromium },
  { name: 'webkit', launcher: webkit },
]

function buildMatrixCases() {
  const cases = []
  for (const look of LOOKS) {
    for (const conversation of CONVERSATIONS_FOR_MATRIX) {
      for (const mode of MODES) {
        cases.push({
          id: `matrix-${mode}-${conversation}-${look}`,
          path: `/dev-fixtures/visitor-chat?mode=${mode}&conversation=${conversation}&look=${look}`,
          waitFor: 'fixture',
        })
      }
    }
  }
  return cases
}

const EXTRA_CASES = [
  {
    id: 'lang-arabic-rtl',
    path: `/dev-fixtures/visitor-chat?conversation=long&language=${encodeURIComponent('العربية')}`,
    waitFor: 'fixture',
  },
  {
    id: 'lang-japanese',
    path: `/dev-fixtures/visitor-chat?conversation=long&language=${encodeURIComponent('日本語')}`,
    waitFor: 'fixture',
  },
  {
    id: 'textsize-larger',
    path: '/dev-fixtures/visitor-chat?conversation=long&textSize=larger',
    waitFor: 'fixture',
  },
  {
    id: 'contrast-high',
    path: '/dev-fixtures/visitor-chat?conversation=long&contrast=high',
    waitFor: 'fixture',
  },
  {
    id: 'webview-appheader-none-pass-placeaction',
    path: '/dev-fixtures/visitor-chat?presentation=webview&appHeader=none&conversation=pass&placeAction=1',
    waitFor: 'fixture',
  },
  {
    id: 'surface-loading',
    path: '/dev-fixtures/visitor-chat?surface=loading',
    waitFor: 'main',
  },
  {
    id: 'surface-error',
    path: '/dev-fixtures/visitor-chat?surface=error',
    waitFor: 'main',
  },
  {
    id: 'surface-temporarily-unavailable',
    path: '/dev-fixtures/visitor-chat?surface=temporarily-unavailable',
    waitFor: 'main',
  },
]

const CASES = [...buildMatrixCases(), ...EXTRA_CASES]

async function hideFrameworkDevChrome(page) {
  await page
    .locator('nextjs-portal')
    .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
    .catch(() => {})
}

async function runCase(page, testCase) {
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const url = `${BASE_URL}${testCase.path}`
  const result = {
    id: testCase.id,
    url,
    consoleErrors,
    pageErrors,
    hydrationOk: false,
    overflow: null,
    axeViolations: null,
    screenshot: null,
    error: null,
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })

    if (testCase.waitFor === 'fixture') {
      await page.waitForSelector('[data-fixture-client-mounted="true"]', { timeout: 15_000 })
    } else {
      await page.waitForSelector('main', { state: 'visible', timeout: 15_000 })
    }
    result.hydrationOk = true

    // Let fonts/images/transitions settle before measuring/screenshotting.
    await page.waitForTimeout(400)
    await hideFrameworkDevChrome(page)

    const dimensions = await page.evaluate(() => ({
      documentScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    result.overflow = {
      ok: dimensions.documentScrollWidth <= dimensions.innerWidth,
      ...dimensions,
    }

    try {
      const axeResult = await new AxeBuilder({ page }).include('main').analyze()
      result.axeViolations = axeResult.violations.map(({ id, impact, description, nodes }) => ({
        id,
        impact,
        description,
        count: nodes.length,
        targets: nodes.slice(0, 5).map((node) => node.target),
      }))
    } catch (axeError) {
      result.axeError = axeError instanceof Error ? axeError.message : String(axeError)
    }

    const screenshotName = `${testCase.id}.png`
    const screenshotPath = path.join(SCREENSHOT_DIR, screenshotName)
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' })
    result.screenshot = screenshotPath
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  return result
}

async function main() {
  await mkdir(SCREENSHOT_DIR, { recursive: true })

  const results = []
  let total = 0
  let failed = 0

  for (const browserSpec of BROWSERS) {
    const browser = await browserSpec.launcher.launch()
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      })
      await context.grantPermissions([])
      for (const testCase of CASES) {
        const page = await context.newPage()
        await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
        total += 1
        const caseId = `${testCase.id}--${browserSpec.name}--${viewport.name}`
        process.stdout.write(`[${total}] ${caseId}\n`)
        const outcome = await runCase(page, {
          ...testCase,
          id: caseId,
        })
        if (
          outcome.error ||
          !outcome.hydrationOk ||
          outcome.pageErrors.length > 0 ||
          (outcome.overflow && !outcome.overflow.ok) ||
          (outcome.axeViolations && outcome.axeViolations.length > 0)
        ) {
          failed += 1
        }
        results.push({
          ...outcome,
          caseId: testCase.id,
          browser: browserSpec.name,
          viewport: viewport.name,
        })
        await page.close()
      }
      await context.close()
    }
    await browser.close()
  }

  const summary = {
    baseUrl: BASE_URL,
    generatedAt: new Date().toISOString(),
    totalRuns: total,
    runsWithIssues: failed,
    matrixCaseCount: buildMatrixCases().length,
    extraCaseCount: EXTRA_CASES.length,
    browsers: BROWSERS.map((b) => b.name),
    viewports: VIEWPORTS.map((v) => v.name),
  }

  await writeFile(
    path.join(QA_DIR, 'results.json'),
    JSON.stringify({ summary, results }, null, 2),
  )

  process.stdout.write(`\nDone. ${total} runs, ${failed} with issues.\n`)
  process.stdout.write(`Results: ${path.join(QA_DIR, 'results.json')}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
