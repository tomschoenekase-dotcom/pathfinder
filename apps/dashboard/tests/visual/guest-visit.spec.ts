import { expect, test, type Page } from '@playwright/test'

const webBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

async function openPreferences(page: Page) {
  const summary = page.locator('summary').filter({ hasText: 'Your visit' })
  await summary.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('North Gallery')).toBeVisible()
}

async function assertOpenLayout(page: Page) {
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((body) => body.clientWidth),
  )
  const interestInput = page.getByLabel('Interests · up to 5, separated by commas')
  const save = page.getByRole('button', { name: 'Save preferences' })
  await interestInput.scrollIntoViewIfNeeded()
  await expect(interestInput).toBeVisible()
  await save.scrollIntoViewIfNeeded()
  await expect(save).toBeVisible()

  const composer = page.getByPlaceholder('Ask anything about this place...')
  await composer.scrollIntoViewIfNeeded()
  await expect(composer).toBeVisible()
  const composerLayout = await composer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const centerTarget = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    return {
      withinViewport:
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth,
      centerIsComposer:
        centerTarget === element ||
        (centerTarget instanceof Element && element.contains(centerTarget)),
    }
  })
  expect(composerLayout.withinViewport).toBe(true)
  expect(composerLayout.centerIsComposer).toBe(true)
}

test('guest visit saved form supports keyboard review and lifecycle semantics', async ({
  page,
}, testInfo) => {
  await page.goto(`${webBaseUrl}/dev-fixtures/guest-visit`)
  await expect(page.locator('[data-fixture="guest-visit"]')).toBeVisible()
  await openPreferences(page)
  await page.getByLabel('North Gallery').check()
  await page.getByLabel('Interests · up to 5, separated by commas').fill('trains, local history')
  await page.getByLabel(/Time left/).fill('45')

  const save = page.getByRole('button', { name: 'Save preferences' })
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    if (await save.evaluate((element) => element === document.activeElement)) break
  }
  await expect(save).toBeFocused()
  await save.press('Enter')
  await expect(page.getByLabel('North Gallery')).toBeChecked()
  await expect(page.getByText('Explicitly visited places:')).toBeVisible()
  await assertOpenLayout(page)
  await save.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath(`guest-visit-open-saved-${testInfo.project.name}.png`),
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Clear chat' }).click()
  await expect(page.getByLabel('North Gallery')).toBeChecked()
  await page.getByRole('button', { name: 'Start a fresh visit' }).click()
  await expect(page.getByLabel('North Gallery')).not.toBeChecked()
  await expect(page.getByText('Explicitly visited places:')).not.toBeVisible()
})

test('guest visit validation error stays visible and usable while open', async ({
  page,
}, testInfo) => {
  await page.goto(`${webBaseUrl}/dev-fixtures/guest-visit`)
  await openPreferences(page)
  await page
    .getByLabel('Interests · up to 5, separated by commas')
    .fill('one, two, three, four, five, six')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Add up to 5 interests.' })).toBeVisible()
  await assertOpenLayout(page)
  await page.getByRole('button', { name: 'Save preferences' }).scrollIntoViewIfNeeded()
  await page.screenshot({
    path: testInfo.outputPath(`guest-visit-open-error-${testInfo.project.name}.png`),
    fullPage: true,
  })
})
