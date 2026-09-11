import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL!
async function hideFrameworkDevChrome(page: Page) {
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  const keylessPrompt = page.getByRole('button', { name: 'Keyless prompt' })
  await keylessPrompt
    .first()
    .waitFor({ state: 'attached', timeout: 2_000 })
    .catch(() => undefined)
  await keylessPrompt.evaluateAll((buttons) => {
    for (const button of buttons) {
      let current: Element | null = button
      while (current?.parentElement && current.parentElement !== document.body) {
        if (window.getComputedStyle(current).position === 'fixed') {
          current.remove()
          current = null
          break
        }
        current = current.parentElement
      }
      current?.remove()
    }
  })
}

async function expectViewportIntegrity(page: Page) {
  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
}

async function expectAccessiblePage(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

async function saveViewportEvidence(page: Page, testInfo: TestInfo) {
  const screenshot = await page.screenshot({
    animations: 'disabled',
    caret: 'hide',
    path: testInfo.outputPath('source-routing-control.png'),
  })
  expect(screenshot.byteLength).toBeGreaterThan(10_000)
}

test('operator selects a paged client specialist and reconciles a stale revision', async ({
  page,
}, testInfo) => {
  const scope = { tenantId: 'fixture-routing-tenant', venueId: 'fixture-routing-venue' }
  const candidate = (id: string, name: string) => ({
    id,
    name,
    agentType: 'CONTENT',
    accessScope: id === 'client-agent' ? 'CLIENT' : 'VENUE',
    enabled: true,
    accessCapabilities: ['intake.read', 'content.draft'],
    autonomyLevel: 'DRAFT',
    autonomousActions: ['content.prepare-draft'],
    defaultProvider: 'codex-bridge',
    defaultModel: 'subscription-default',
    createdAt: '2026-09-10T00:00:00Z',
  })
  let policy: null | Record<string, unknown> = null
  const mutations: Array<Record<string, unknown>> = []
  await page.route('**/api/trpc/**', async (route) => {
    const url = new URL(route.request().url())
    const procedures = decodeURIComponent(url.pathname.split('/api/trpc/')[1]!).split(',')
    const inputs =
      route.request().method() === 'POST'
        ? route.request().postDataJSON()
        : JSON.parse(url.searchParams.get('input') ?? '{}')
    const results = procedures.map((procedure, index) => {
      const input = inputs[String(index)]?.json ?? inputs.json
      if (procedure === 'admin.getIntakeSourceAgentRouting')
        return { result: { data: { json: policy } } }
      if (procedure === 'admin.listIntakeSourceAgentRoutingCandidates')
        return {
          result: {
            data: {
              json: input.cursor
                ? {
                    items: [candidate('client-agent', 'Client-wide museum source specialist')],
                    nextCursor: null,
                  }
                : {
                    items: [candidate('venue-agent', 'Venue source specialist')],
                    nextCursor: { createdAt: '2026-09-10T00:00:00Z', id: 'venue-agent' },
                  },
            },
          },
        }
      if (procedure === 'admin.configureIntakeSourceAgentRouting') {
        mutations.push(input)
        if (mutations.length === 2) {
          policy = { ...scope, agentIdentityId: 'client-agent', enabled: false, revision: 2 }
          return {
            error: {
              json: {
                message: 'Source routing changed',
                code: -32009,
                data: { code: 'CONFLICT', httpStatus: 409 },
              },
            },
          }
        }
        policy = {
          ...scope,
          agentIdentityId: input.agentIdentityId,
          enabled: input.enabled,
          revision: 1,
        }
        return { result: { data: { json: { policy, taskDispatched: false } } } }
      }
      throw Error('Unexpected procedure ' + procedure)
    })
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(url.searchParams.get('batch') === '1' ? results : results[0]),
    })
  })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/intake-source-routing`)
  await hideFrameworkDevChrome(page)
  const select = page.getByRole('combobox', { name: 'Content specialist' })
  await expect(select).toHaveValue('')
  const save = page.getByRole('button', { name: 'Save routing' })
  await expect(save).toBeDisabled()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await page.getByRole('button', { name: 'Load more specialists' }).click()
  await select.selectOption('client-agent')
  await page.getByRole('checkbox').check()
  await save.focus()
  await expect(save).toBeFocused()
  await save.press('Enter')
  await expect(page.getByRole('status')).toContainText('routing saved')
  expect(mutations[0]).toEqual({
    ...scope,
    agentIdentityId: 'client-agent',
    expectedRevision: 0,
    enabled: true,
  })
  await page.getByRole('checkbox').uncheck()
  await save.click()
  await expect(
    page.getByRole('region', { name: 'Source review preparation' }).getByRole('alert'),
  ).toContainText('changed after this page loaded')
  await expect(save).toBeDisabled()
  await page.screenshot({
    path: testInfo.outputPath('source-routing-conflict.png'),
    animations: 'disabled',
  })
  await page.getByRole('button', { name: 'Refresh configuration' }).click()
  await expect(page.getByRole('checkbox')).not.toBeChecked()
  await expect(select).toHaveValue('client-agent')
  expect(mutations).toHaveLength(2)
  await expectViewportIntegrity(page)
  await expectAccessiblePage(page)
  await saveViewportEvidence(page, testInfo)
})
