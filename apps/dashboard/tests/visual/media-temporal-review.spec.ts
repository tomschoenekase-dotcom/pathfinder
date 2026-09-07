import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const artifactDir = resolve(process.cwd(), 'artifacts/media-temporal-review')

test('all-held receipt remains usable at 320px and desktop', async ({ page }) => {
  mkdirSync(artifactDir, { recursive: true })
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto(`${baseUrl}/dev-fixtures/media-temporal-review`)
  await page.getByRole('button', { name: 'Retain evidence receipt' }).click()
  await expect(
    page.getByText(/receipt was saved, but its evidence page could not be read/u),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry evidence readback' }).click()
  await expect(page.getByText('Read retained evidence')).toBeVisible()
  await page.getByText('Read retained evidence').click()
  await expect(page.getByText(/North entrance hours/u)).toBeVisible()
  await page.getByRole('button', { name: 'Next evidence' }).click()
  await expect(page.getByText(/North entrance access/u)).toBeVisible()
  await page.getByRole('button', { name: 'Previous evidence' }).click()
  await expect(page.getByText(/North entrance hours/u)).toBeVisible()
  await page.getByLabel('Held target to clarify').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.getByLabel('Optional scoped Content identity').fill('content-agent')
  await expect(page.getByRole('button', { name: 'Create local clarification' })).toBeEnabled()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
  await page.screenshot({ path: resolve(artifactDir, 'temporal-review-320.png'), fullPage: true })

  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: resolve(artifactDir, 'temporal-review-1440.png'), fullPage: true })
})
