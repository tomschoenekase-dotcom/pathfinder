import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('dashboard shell exposes skip navigation and focuses new route content', async ({ page }) => {
  await page.goto(`${baseUrl}/dev-fixtures/route-focus-accessibility`)
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%'
  })

  await page.keyboard.press('Tab')
  const skipLink = page.getByRole('link', { name: 'Skip to main content' })
  await expect(skipLink).toBeFocused()
  await skipLink.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()

  const routeTrigger = page.getByRole('button', { name: 'Open control room' })
  await routeTrigger.focus()
  await routeTrigger.press('Enter')
  const heading = page.getByRole('heading', { name: 'Control room' })
  await expect(heading).toBeFocused()
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.getByRole('button', { name: 'Open navigation' }).click()
  }
  await expect(page.getByRole('link', { name: 'Control room' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  if ((page.viewportSize()?.width ?? 0) < 1024) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
  }

  const overflowNodes = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { tag: element.tagName, left: rect.left, right: rect.right, width: rect.width }
      })
      .filter(
        ({ left, right, width: elementWidth }) =>
          elementWidth > 0 && (left < -1 || right > width + 1),
      )
  })
  expect(overflowNodes).toEqual([])

  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
})
