import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const draft = (applicability?: object) =>
  JSON.stringify(
    {
      kind: 'OPERATIONAL_FACT',
      label: 'Coat check entry',
      value: 'Enter coat check through the north door.',
      ...(applicability ? { applicability } : {}),
    },
    null,
    2,
  )
const subjects = {
  scope: 'SUBJECTS',
  subjectModuleIds: ['fixture-coat-check'],
  placeIds: ['fixture-north-door'],
}

test.beforeEach(async ({ page }) => {
  // The fixture uses an in-memory client; fail any accidental API/provider request.
  await page.route('**/api/**', (route) => route.abort('blockedbyclient'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/dev-fixtures/fact-applicability')
  await page.getByLabel('Action target').selectOption('fixture-fact')
})

test('review declaration addition/removal, invalid targets, successor unknown and exact publication', async ({
  page,
}, info) => {
  const payload = page.getByLabel('Typed payload JSON')
  const workbench = page.getByRole('region', { name: 'Immutable revision editor' })
  await expect(payload).not.toHaveValue(/applicability/)
  await expect(
    page.getByText('Stored module fixture-fact · v3 · revision fixture-revision-3'),
  ).toBeVisible()
  await expect(page.getByText('Unknown — no declaration recorded.')).toBeVisible()
  await payload.fill(draft(subjects))
  const preview = page.getByRole('button', { name: 'Validate and preview' })
  // Enter submits the native button; feedback receives focus.
  await preview.focus()
  await preview.press('Tab')
  await expect(page.getByRole('button', { name: 'Append revision', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(preview).toBeFocused()
  await preview.press('Enter')
  await expect(page.getByRole('status')).toContainText('EFFECTIVE')
  await expect(page.getByRole('heading', { name: 'Content action recorded' })).toBeFocused()
  await payload.fill(draft())
  await preview.click()
  await expect(page.getByRole('status')).toBeVisible()
  await expect(page.getByText('Unknown — no declaration recorded.')).toBeVisible()
  await payload.fill('{')
  await preview.click()
  await expect(workbench.getByRole('alert')).toContainText('could not be validated')
  await expect(page.getByRole('heading', { name: 'Content action needs attention' })).toBeFocused()
  await payload.fill(draft({ scope: 'SUBJECTS', subjectModuleIds: [], placeIds: [] }))
  await preview.click()
  await expect(workbench.getByRole('alert')).toBeVisible()
  await expect(
    page.getByText('Invalid declaration — validate and correct the draft.'),
  ).toBeVisible()
  await page.screenshot({ path: info.outputPath('invalid-declaration.png'), fullPage: true })
  await payload.fill(
    draft({ scope: 'SUBJECTS', subjectModuleIds: ['unavailable-other-venue'], placeIds: [] }),
  )
  await preview.click()
  await expect(workbench.getByRole('alert')).toContainText('could not be validated')
  await page.screenshot({ path: info.outputPath('invalid-target.png'), fullPage: true })
  await payload.fill(draft(subjects))
  await page.getByRole('button', { name: 'Append revision', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Version 4 recorded')
  await expect(payload).toBeDisabled()
  await page.getByRole('button', { name: 'Load latest fixture state' }).click()
  await page.getByLabel('Action target').selectOption('fixture-fact')
  await expect(
    page.getByText('Stored module fixture-fact · v4 · revision fixture-revision-4'),
  ).toBeVisible()
  await expect(payload).not.toHaveValue(/applicability/)
  await expect(page.getByText('Unknown — no declaration recorded.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('publication-review.png'), fullPage: true })
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Publish this version to guests' }).click()
  await expect(page.getByRole('button', { name: 'Publish this version to guests' })).toBeEnabled()
  let confirmation = ''
  page.once('dialog', async (dialog) => {
    confirmation = dialog.message()
    await dialog.accept()
  })
  await page.getByRole('button', { name: 'Publish this version to guests' }).click()
  await expect(page.getByRole('status')).toContainText('Version 4 is explicitly published')
  expect(confirmation).toContain('revision fixture-revision-4')
  expect(confirmation).toContain('fixture-coat-check')
  expect(confirmation).toContain('fixture-north-door')
  expect(confirmation).toContain('independent review is not enforced')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
  ).toEqual([])
})

test('retirement discloses unknown successor and persistent publication, supports keyboard cancel', async ({
  page,
}, info) => {
  await page.getByRole('button', { name: 'Append retirement revision' }).click()
  await expect(page.getByText(/The retirement revision has unknown applicability/)).toBeVisible()
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await cancel.focus()
  await cancel.press('Enter')
  await expect(page.getByLabel('Retirement effective at')).toHaveCount(0)
  await page.getByRole('button', { name: 'Append retirement revision' }).click()
  await page.getByLabel('Retirement effective at').fill('2026-10-24T18:00')
  await page.screenshot({ path: info.outputPath('retirement-review.png'), fullPage: true })
  await page.getByRole('button', { name: 'Confirm retirement revision' }).click()
  await expect(page.getByRole('status')).toContainText('Retirement boundary recorded as version 4')
  await page.getByRole('button', { name: 'Load latest fixture state' }).click()
  await page.getByLabel('Action target').selectOption('fixture-fact')
  await expect(page.getByText('Unknown — no declaration recorded.')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Withdraw from guest guide' })).toBeVisible()
  await page.getByText('Mock write receipt', { exact: true }).click()
  await expect(page.locator('pre')).toContainText('"publishedRevisionId": "fixture-revision-3"')
  await expect(page.locator('pre')).not.toContainText('"applicability"')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
