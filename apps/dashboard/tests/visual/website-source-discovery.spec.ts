import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('source inventory preserves readable provenance and complete pagination', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'One project covers four widths.')
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
  await page.goto(
    `${process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'}/dev-fixtures/website-source-discovery`,
  )
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  const summary = page.locator('summary').filter({ hasText: 'Source inventory' })
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText(/historical policy did not extract PDF text/)).toBeVisible()
  await expect(page.getByText(/ownership and topic coverage have not been verified/)).toBeVisible()
  await expect(page.getByText(/not the source publication or update date/)).toBeVisible()
  await expect(page.getByText(/repeated pages are not independent corroboration/)).toBeVisible()
  const imageReference = page.getByRole('listitem').filter({
    has: page.getByRole('link', { name: 'https://greenhouse.example/site-map.png', exact: true }),
  })
  await expect(
    imageReference.getByText('Image \u00b7 adapter unavailable', { exact: true }),
  ).toBeVisible()
  await expect(
    imageReference.getByText('Depth 1 \u00b7 not downloaded', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/1 exact-byte repeats/)).toBeVisible()
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 820, height: 1180 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    expect(
      await page.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await expect(page.getByRole('listitem')).toHaveCount(20)
    await expect(page.getByRole('button', { name: 'Previous sources' })).toBeDisabled()
    await page.getByRole('button', { name: 'Next sources' }).click()
    await expect(page.getByText('Page 2 of 2')).toBeVisible()
    await expect(page.getByRole('listitem')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Next sources' })).toBeDisabled()
    await expect(
      page.getByRole('link', {
        name: 'https://greenhouse.example/archive/guide-15.pdf',
        exact: true,
      }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Previous sources' }).click()
    await expect(page.getByText('Page 1 of 2')).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath(`website-source-discovery-${viewport.width}.png`),
      fullPage: true,
    })
  }
  expect(errors).toEqual([])
})
