import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

async function openFixture(page: Page, query: string) {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(`${visitorBaseUrl}/dev-fixtures/visitor-chat?${query}`)
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.locator('#chat-input')).toBeEnabled()
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    )
    .toBe(true)
}

async function expectAxeClean(page: Page) {
  const result = await new AxeBuilder({ page }).include('body').analyze()
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
    })),
  ).toEqual([])
}

test('visitor chat preserves its text path at 200% root text size', async ({ page }) => {
  await openFixture(
    page,
    'mode=classic&state=idle&conversation=long&motion=reduced&voice=none&network=online&language=English',
  )
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })

  await expect(page.getByRole('heading', { name: 'Museum Guide' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  const composer = page.locator('#chat-input')
  await composer.scrollIntoViewIfNeeded()
  await composer.focus()
  await expect(composer).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expectAxeClean(page)
})

test('voice failure is announced while the equivalent text path stays operable', async ({
  page,
}) => {
  await openFixture(
    page,
    'mode=classic&state=idle&conversation=empty&motion=reduced&voice=error&network=online&language=English',
  )

  await expect(page.getByRole('button', { name: 'Try voice conversation again' })).toBeVisible()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Microphone access was denied' }),
  ).toBeVisible()
  const composer = page.locator('#chat-input')
  await composer.fill('Use the text path')
  await expect(composer).toHaveValue('Use the text path')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await expectAxeClean(page)
})

test('missing character media retains an announced fallback and complete text chat', async ({
  page,
}) => {
  await openFixture(
    page,
    'mode=character&state=idle&conversation=empty&asset=missing&motion=reduced&voice=none&network=online&language=English',
  )

  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Character display unavailable; text chat is ready' }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('main')).toBeVisible()
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  const composer = page.locator('#chat-input')
  await expect(composer).toBeEnabled()
  await composer.fill('Continue without character media')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await expectAxeClean(page)
})
