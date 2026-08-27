import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('admin controls retain named semantics at 200% text without provider work', async ({
  page,
}) => {
  await page.goto(`${baseUrl}/dev-fixtures/admin-accessibility`)
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%'
  })

  await expect(page.getByRole('heading', { name: 'Admin control semantics' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Client status' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Client plan' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark notable' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(page.getByRole('textbox', { name: 'Private admin note' })).toBeVisible()
  await expect(page.getByLabel('Primary client contact')).toBeVisible()
  await expect(page.getByLabel('Client name')).toBeVisible()
  await expect(page.getByLabel('Venue name')).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true)

  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
})
