import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
if (new URL(baseUrl).hostname !== '127.0.0.1')
  throw new Error('Admin QA requires a loopback dashboard')
const allowedOrigin = new URL(baseUrl).origin
const proofDir = resolve(__dirname, '../../../../../qa/rendered')

test('admin system fixture has usable navigation and context at three widths', async ({ page }) => {
  test.setTimeout(180_000)
  await mkdir(proofDir, { recursive: true })
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (/^(?:about:|data:|blob:)/u.test(url) || new URL(url).origin === allowedOrigin) {
      return route.continue()
    }
    return route.abort()
  })
  for (const width of [390, 1280, 1680]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${baseUrl}/dev-fixtures/admin-ai-systems`)
    await expect(page.getByRole('button', { name: 'Copy for Codex' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Search or jump/i })).toBeVisible()
    if (width === 390) {
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await expect(page.getByRole('navigation', { name: 'Torchiko OS navigation' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
    } else {
      await expect(
        page.getByRole('navigation', { name: 'Torchiko OS navigation' }).getByRole('link'),
      ).toHaveCount(5)
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true)
    await page.screenshot({ path: resolve(proofDir, `admin-system-${width}.png`), fullPage: true })
    const axe = await new AxeBuilder({ page }).include('body').analyze()
    expect(
      axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
    ).toEqual([])
  }
})
