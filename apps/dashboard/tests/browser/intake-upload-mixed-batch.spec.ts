import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 320, height: 760 } })

test('keeps every mixed-batch result visible and retryable on a narrow keyboard path', async ({
  page,
}, testInfo) => {
  await page.goto('/dev-fixtures/upload-states?state=mixed')

  await expect(page.getByText('gallery-entry.jpg')).toBeVisible()
  await expect(page.getByText('museum-arrival-guide.pdf')).toBeVisible()
  await expect(page.getByText('installer.exe')).toBeVisible()
  await expect(page.getByText('Checks complete — awaiting review')).toBeVisible()
  await expect(page.getByText('Cannot be added')).toBeVisible()

  const beforePath = testInfo.outputPath('mixed-upload-before-recovery-320.png')
  await page.screenshot({ path: beforePath, fullPage: true })
  await testInfo.attach('mixed upload before recovery at 320px', {
    path: beforePath,
    contentType: 'image/png',
  })

  await page.getByLabel('Choose files').setInputFiles([
    { name: 'new-visitor-guide.pdf', mimeType: 'application/pdf', buffer: Buffer.from('guide') },
    {
      name: 'unsafe-installer.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('binary'),
    },
  ])
  await expect(page.getByText('new-visitor-guide.pdf')).toBeVisible()
  await expect(page.getByText('unsafe-installer.exe')).toBeVisible()
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByText('Checks complete — awaiting review')).toHaveCount(2)

  const retry = page.getByRole('button', { name: 'Retry' })
  await retry.focus()
  await expect(retry).toBeFocused()
  await retry.press('Enter')
  await expect(page.getByText('Checks complete — awaiting review')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  const accessibility = await new AxeBuilder({ page }).include('main').analyze()
  expect(accessibility.violations).toEqual([])
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  const screenshotPath = testInfo.outputPath('mixed-upload-recovered-320.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('mixed upload at 320px', { path: screenshotPath, contentType: 'image/png' })
})
