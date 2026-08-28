import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('campaign dialog remains keyboard-contained and readable at 200% text', async ({ page }) => {
  await page.goto(`${baseUrl}/dev-fixtures/dialog-accessibility`)
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%'
  })

  await page.getByRole('checkbox', { name: 'Select all shown prospects' }).check()
  const opener = page.getByRole('button', { name: 'Create outreach campaign' })
  await opener.focus()
  await opener.press('Enter')

  const dialog = page.getByRole('dialog', { name: 'Create outreach campaign' })
  const name = page.getByRole('textbox', { name: 'Campaign name' })
  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect(dialog).toBeVisible()
  await expect(name).toBeFocused()
  await expect(dialog).toHaveAttribute('aria-describedby', 'campaign-description')
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')

  await name.press('Shift+Tab')
  await expect(cancel).toBeFocused()
  await cancel.press('Tab')
  await expect(name).toBeFocused()

  const overflowNodes = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          tag: element.tagName.toLowerCase(),
          text: element.textContent?.trim().slice(0, 80) ?? '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        }
      })
      .filter(
        ({ left, right, width: elementWidth }) =>
          elementWidth > 0 && (left < -1 || right > width + 1),
      )
      .slice(0, 20)
  })
  expect(overflowNodes).toEqual([])
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('')
})
