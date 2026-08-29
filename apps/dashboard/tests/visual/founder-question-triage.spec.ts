import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
  return errors
}

test('founder question queue supports fast evidence-backed triage without widening authority', async ({
  page,
}, testInfo) => {
  const runtimeErrors = captureRuntimeErrors(page)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${dashboardBaseUrl}/dev-fixtures/founder-question-triage`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))

  await expect(page.locator('[data-fixture="founder-question-triage"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Needs you' })).toBeVisible()
  await expect(page.getByText(/Showing 3 of 3 loaded open questions/)).toBeVisible()
  await expect(page.getByText(/additional older questions exist/)).toBeVisible()

  const foundational = page.getByText('Which building does the uploaded handbook describe?')
  const foundationalCard = foundational.locator('xpath=ancestor::details')
  await expect(foundational).toBeVisible()
  await expect(page.getByText('Handbook cover')).toBeHidden()
  await foundational.click()
  await expect(page.getByText('Handbook cover')).toBeVisible()
  await expect(foundationalCard.getByText(/does not approve, apply, or publish/)).toBeVisible()
  const answer = foundationalCard.getByLabel('Your answer')
  await answer.focus()
  await expect(answer).toBeFocused()

  await page.getByLabel('Dependency').selectOption('LOCAL')
  await expect(foundational).toBeHidden()
  await expect(page.getByText('Are the holiday café hours still current?')).toBeVisible()
  await expect(page.getByText(/Showing 2 of 3 loaded open questions/)).toBeVisible()
  await page.getByLabel('Find a question').fill('River Room')
  await expect(page.getByText('Should “River Room” be retained as a public alias?')).toBeVisible()
  await expect(page.getByText('Are the holiday café hours still current?')).toBeHidden()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(foundational).toBeVisible()

  await expect
    .poll(() => page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1))
    .toBe(true)
  const axe = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    axe.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
  expect(runtimeErrors).toEqual([])

  await testInfo.attach(`founder-question-triage-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
})
