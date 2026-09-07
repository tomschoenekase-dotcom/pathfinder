import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('reads retained evidence on demand and returns to the prior source page', async ({ page }) => {
  await page.goto('/dev-fixtures/media-intake-handoff')
  await expect(page.getByLabel('Retained media evidence page')).toHaveCount(0)
  await page.getByRole('button', { name: 'Read retained media evidence' }).click()
  await expect(page.getByLabel('Retained media evidence page')).toContainText(
    'route beyond the sign was not filmed',
  )
  await page.getByRole('button', { name: 'Next evidence page' }).click()
  await expect(page.getByLabel('Retained media evidence page')).toContainText(
    'reception-assistance-sign.jpg',
  )
  await page.getByRole('button', { name: 'Previous evidence page' }).click()
  await expect(page.getByLabel('Retained media evidence page')).toContainText(
    'north-hall-walkthrough.mp4',
  )
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('binds saved items, retains an uncertain request, and links the resulting proposal', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/dev-fixtures/media-intake-handoff')
  await page.getByRole('button', { name: 'Prepare saved review' }).click()
  await expect(page.getByRole('button', { name: 'Create Builder proposal' })).toBeDisabled()
  await page.getByRole('button', { name: 'Load more supporting sources' }).click()
  await page
    .getByRole('combobox', { name: 'North Hall and the east entrance visitor information desk' })
    .selectOption('s1')
  await page.getByRole('combobox', { name: 'Arrival assistance' }).selectOption('s2')
  await page
    .getByRole('textbox', { name: 'Review note' })
    .fill('Verified both signs and excluded the unfilmed route.')
  await page.getByRole('button', { name: 'Create Builder proposal' }).click()
  await expect(
    page.getByRole('region', { name: 'Send reviewed content to Builder' }).getByRole('alert'),
  ).toContainText('handoff was not confirmed')
  await expect(page.getByRole('combobox', { name: 'Arrival assistance' })).toBeDisabled()
  expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
  await page.screenshot({ path: test.info().outputPath('media-handoff-retry.png'), fullPage: true })
  await page.getByRole('button', { name: 'Retry same handoff' }).click()
  await expect(page.getByRole('link', { name: 'Open in Builder' })).toHaveAttribute(
    'href',
    '/admin/clients/fixture-tenant/venues/fixture-venue/intake?runId=fixture-media-review-run',
  )
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  expect(errors).toEqual([])
})

test('keeps long item labels and source controls usable at narrow phone and tablet widths', async ({
  page,
}) => {
  await page.goto('/dev-fixtures/media-intake-handoff')
  await page.getByRole('button', { name: 'Prepare saved review' }).click()
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    const select = page.getByRole('combobox').first()
    const box = await select.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
    expect(box?.width).toBeGreaterThan(150)
    await select.focus()
    await expect(select).toBeFocused()
  }
})
