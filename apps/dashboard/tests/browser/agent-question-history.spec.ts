import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

test('keeps a saved agent answer and its discussion reachable at each viewport', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev-fixtures/agent-question-history')

    await expect(page.getByRole('heading', { name: 'Question history' })).toBeVisible()
    await expect(page.getByText('Recorded response', { exact: true })).toBeVisible()
    await expect(
      page.getByText(
        'Use the east entrance after 9 a.m.; staff will direct accessible arrivals there.',
      ),
    ).toBeVisible()
    await expect(page.getByText('Question discussion', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Answer agent' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Answered' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('link', { name: 'Older questions' })).toHaveAttribute(
      'href',
      /questionStatus=ANSWERED.*questionCursorCreatedAt=.*questionCursorId=fixture-history-older-question#inbox/,
    )
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('#inbox').analyze()).violations).toEqual([])
    await page.locator('#inbox').screenshot({
      path: testInfo.outputPath(`agent-question-history-inbox-${viewport.name}.png`),
    })
  }

  expect(pageErrors).toEqual([])
})
