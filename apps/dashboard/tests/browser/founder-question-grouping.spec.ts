import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

const prompts = [
  'Is the accessible north entrance ready for today’s visitors?',
  'Should the temporary arrival sign remain beside that entrance?',
  'Are the café holiday hours still current?',
  'Is the south loading entrance excluded from visitor directions?',
  'Should the River Room alias remain searchable?',
  'Does the seasonal coat-check note need another source?',
]

test('groups only an exact scoped workflow and preserves every individual question', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/dev-fixtures/founder-question-grouping')
  await expect(page.getByRole('heading', { name: 'Workflow grouping' })).toBeVisible()
  await expect(page.locator('details.group')).toHaveCount(6)
  await expect(page.getByLabel('Individual questions')).toBeChecked()

  const urgentCard = page.locator('details.group').filter({ hasText: prompts[0]! })
  await urgentCard.locator(':scope > summary').click()
  const draft = 'Keep the north entrance staffed while the final sign is checked.'
  await urgentCard.getByLabel('Your answer').fill(draft)

  await page.getByLabel('Group by workflow').focus()
  await page.keyboard.press('Space')
  await expect(page.getByLabel('Group by workflow')).toBeChecked()
  await expect(page.locator('details.group')).toHaveCount(6)
  for (const prompt of prompts) await expect(page.getByText(prompt, { exact: true })).toBeVisible()

  const northWorkflowLink = page.locator(
    'a[href="/admin/clients/tenant-north/venues/venue-north/agents/runs/shared-run-reference"]',
  )
  const sharedHeading = northWorkflowLink.locator('xpath=ancestor::div[@data-workflow-group][1]')
  const sharedCards = sharedHeading.locator('xpath=following-sibling::details[position() <= 2]')
  await expect(
    sharedHeading.getByText('2 matching loaded questions in this workflow.'),
  ).toBeVisible()
  await expect(sharedCards).toHaveCount(2)
  await expect(sharedCards.nth(0)).toContainText(prompts[0]!)
  await expect(sharedCards.nth(1)).toContainText(prompts[1]!)
  await expect(
    page.locator(
      'a[href="/admin/clients/tenant-south/venues/venue-south/agents/runs/shared-run-reference"]',
    ),
  ).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Open workflow' })).toHaveCount(3)
  await expect(sharedCards.nth(0)).toHaveAttribute('open', '')
  await expect(sharedCards.nth(0).getByLabel('Your answer')).toHaveValue(draft)
  await expect(sharedCards.nth(0).getByText('Retained source', { exact: true })).toBeVisible()

  await page.getByLabel('Individual questions').check()
  const restoredUrgentCard = page.locator('details.group').filter({ hasText: prompts[0]! })
  await expect(restoredUrgentCard).toHaveAttribute('open', '')
  await expect(restoredUrgentCard.getByLabel('Your answer')).toHaveValue(draft)
})

test('filters before grouping and finds venue names without merging runless questions', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/dev-fixtures/founder-question-grouping')
  await page.getByLabel('Group by workflow').check()
  await page.getByLabel('Find a question').fill('South Museum')
  await expect(page.locator('details.group')).toHaveCount(1)
  await expect(page.getByText(prompts[3]!, { exact: true })).toBeVisible()
  await expect(page.getByText('Showing 1 matching questions from 6')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByText('Should the River Room alias remain searchable?')).toBeVisible()
  await expect(
    page.getByText('Does the seasonal coat-check note need another source?'),
  ).toBeVisible()
})

test('keeps grouped review accessible and free of horizontal overflow at four widths', async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/dev-fixtures/founder-question-grouping')
    await page.getByLabel('Group by workflow').check()
    await expect(page.locator('details.group')).toHaveCount(6)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    expect((await new AxeBuilder({ page }).include('main').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`founder-question-grouping-${viewport.name}.png`),
      fullPage: true,
    })
  }
})
