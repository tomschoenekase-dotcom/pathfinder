import { expect, test, type Page } from '@playwright/test'

const webBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

async function expectNoVisitForm(page: Page) {
  // The fixture deliberately still offers the old preferences slot. The real
  // shell must not mount it, even as a collapsed/hidden replacement onboarding.
  await expect(page.locator('summary').filter({ hasText: 'Your visit' })).toHaveCount(0)
  await expect(page.getByLabel('North Gallery')).toHaveCount(0)
  await expect(page.getByLabel('Interests · up to 5, separated by commas')).toHaveCount(0)
  await expect(page.getByLabel(/Time left/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save preferences', includeHidden: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start a fresh visit', includeHidden: true })).toHaveCount(0)
}

async function assertChatLayout(page: Page) {
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((body) => body.clientWidth),
  )
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

test('guest visit context uses normal chat without mounting a separate profile form', async ({
  page,
}, testInfo) => {
  await page.goto(`${webBaseUrl}/dev-fixtures/guest-visit`)
  await expect(page.locator('[data-fixture="guest-visit"]')).toBeVisible()
  await expectNoVisitForm(page)
  await expect(page.getByText('I want to see the trains.', { exact: true })).toBeVisible()
  const composer = page.getByPlaceholder('Ask anything about this place...')
  await composer.focus()
  await expect(composer).toBeFocused()
  await composer.fill('We like trains and local history, and have 45 minutes.')
  await expect(composer).toHaveValue('We like trains and local history, and have 45 minutes.')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await assertChatLayout(page)
  await page.screenshot({
    path: testInfo.outputPath(`guest-visit-text-first-${testInfo.project.name}.png`),
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Clear chat' }).click()
  await expect(page.getByText('I want to see the trains.', { exact: true })).toHaveCount(0)
  await expectNoVisitForm(page)
  await expect(page.getByText('Explicitly visited places:')).not.toBeVisible()
})

test('legacy preference state cannot block the text-first composer', async ({
  page,
}, testInfo) => {
  await page.goto(`${webBaseUrl}/dev-fixtures/guest-visit`)
  await expect(page.locator('[data-fixture="guest-visit"]')).toBeVisible()
  await page.getByRole('button', { name: 'Pause preference editing', exact: true }).click()
  await expectNoVisitForm(page)
  const composer = page.getByPlaceholder('Ask anything about this place...')
  await expect(composer).toBeEditable()
  await composer.fill('We need a quiet, accessible route through the museum.')
  await composer.focus()
  await expect(composer).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await assertChatLayout(page)
  await page.screenshot({
    path: testInfo.outputPath(`guest-visit-legacy-state-${testInfo.project.name}.png`),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Enable preference editing', exact: true }).click()
  await expectNoVisitForm(page)
  await expect(composer).toHaveValue('We need a quiet, accessible route through the museum.')
})
