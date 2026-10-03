import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('source setup, exact review and refresh controls work at four widths', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === 'tablet-820x1180',
    'Mobile and desktop both exercise the journey plus four widths.',
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page.goto(
    `${process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'}/dev-fixtures/source-connections`,
  )
  await expect(page.getByText('No approved web sources are set up for this venue.')).toBeVisible()
  await page.getByLabel('Source name', { exact: true }).fill('Synthetic public program')
  await page.getByLabel('Public source URL', { exact: true }).fill('https://example.org/program')
  await page.getByLabel('Time zone', { exact: true }).fill('Unknown/Zone')
  await page.getByRole('button', { name: 'Add draft', exact: true }).click()
  await expect(page.locator('main').getByRole('alert')).toContainText('Unknown IANA timezone')
  await page.getByLabel('Time zone', { exact: true }).fill('America/Chicago')
  await page
    .getByRole('combobox', { name: 'Publication policy', exact: true })
    .selectOption('auto_verified')
  const add = page.getByRole('button', { name: 'Add draft', exact: true })
  await add.focus()
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  const source = page.getByTestId('source-connection-fixture_source_0')
  await expect(source).toBeVisible()
  await expect(source.getByRole('button', { name: 'Approve preview', exact: true })).toBeDisabled()
  await source.getByRole('button', { name: 'Preview source', exact: true }).click()
  await expect(source.getByText('Saturday public program', { exact: true })).toBeVisible()
  await expect(source.getByText(/1 fetch, 1240 bytes/)).toBeVisible()
  await expect(source.getByText(/Sat, Oct 10, 10:00\sAM – 11:00\sAM CDT/)).toBeVisible()
  await expect(
    source.getByRole('link', { name: 'https://example.org/program', exact: true }),
  ).toBeVisible()
  await source.getByRole('button', { name: 'Approve preview', exact: true }).click()
  await expect(source.getByText('Running', { exact: true })).toBeVisible()
  await expect(source.getByRole('button', { name: 'Approve preview', exact: true })).toBeDisabled()
  await source.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(source.getByText('Paused', { exact: true })).toBeVisible()
  await expect(source.getByRole('button', { name: 'Refresh now', exact: true })).toBeDisabled()
  await source.getByRole('button', { name: 'Resume', exact: true }).click()
  await source.getByRole('button', { name: 'Refresh now', exact: true }).click()
  await expect(source.getByText(/The source could not be reached/)).toBeVisible()
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport)
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    await expect(source.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`source-connections-${viewport.width}.png`),
      fullPage: true,
    })
  }
  const advanced = page.getByText('Advanced mapping and validation', { exact: true })
  await advanced.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Maximum requests per day', { exact: true })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Minimum records', { exact: true })).toBeFocused()
  expect(errors).toEqual([])
})
