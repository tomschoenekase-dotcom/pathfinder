import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const width of [390, 820, 1440]) {
  test(`rejected learning review prepares a manual case at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const submissions: Array<Record<string, unknown>> = []
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort()
      if (!url.pathname.startsWith('/api/trpc/')) return route.continue()
      const methods = url.pathname.split('/').at(-1)!.split(',')
      const inputs = JSON.parse(route.request().postData() ?? '{}')
      const results = methods.map((method, index) => {
        if (method !== 'admin.prepareConversationEvaluationCase')
          throw new Error(`Unexpected fixture RPC: ${method}`)
        submissions.push(inputs[String(index)]?.json ?? {})
        return submissions.length === 1
          ? {
              error: {
                json: {
                  message: 'Synthetic revision conflict',
                  code: -32009,
                  data: { code: 'CONFLICT', httpStatus: 409, path: method },
                },
              },
            }
          : { result: { data: { json: { id: 'fixture-case', revision: 1, replayed: false } } } }
      })
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(results) })
    })
    await page.goto('/dev-fixtures/rejected-learning-evaluation')
    await expect(page.getByText('Reviewer feedback', { exact: true })).toBeVisible()
    await expect(page.getByText('Original visitor question', { exact: true })).toHaveCount(0)
    const question = page.getByRole('textbox', { name: 'Sanitized visitor question' })
    await expect(question).toHaveValue('')
    await expect(page.getByRole('textbox', { name: 'Acceptable answer phrases' })).toHaveValue('')
    await expect(page.getByRole('button', { name: 'Prepare immutable case' })).toBeDisabled()
    await question.fill('Which Case 12 display am I looking at?')
    await page.getByRole('combobox', { name: 'Expected behavior' }).selectOption('UNKNOWN_ANSWER')
    await page
      .getByRole('textbox', { name: 'Acceptable answer phrases' })
      .fill('Which floor are you on?')
    await page
      .getByRole('textbox', { name: 'Forbidden answer phrases' })
      .fill('Both displays are the same exhibit')
    const confirmation = page.getByRole('checkbox', { name: 'Confirm evaluation case redaction' })
    await confirmation.focus()
    await page.keyboard.press('Space')
    await expect(confirmation).toBeChecked()
    await page.screenshot({
      path: info.outputPath(`rejected-learning-review-${width}.png`),
      fullPage: true,
    })
    await page.getByRole('button', { name: 'Prepare immutable case' }).click()
    await expect(page.getByRole('status')).toContainText('could not be prepared')
    await expect(question).toHaveValue('Which Case 12 display am I looking at?')
    await page.getByRole('button', { name: 'Prepare immutable case' }).click()
    await expect(page.getByRole('status')).toContainText('No AI run was started')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).toEqual(submissions[1])
    expect(submissions[1]).toMatchObject({
      expectedCandidateRevision: 3,
      sanitizationConfirmed: true,
      sanitizedQuestion: 'Which Case 12 display am I looking at?',
    })
    expect(JSON.stringify(submissions)).not.toContain('Do not merge their exhibit records')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    const accessibility = await new AxeBuilder({ page }).include('main').analyze()
    expect(
      accessibility.violations.filter((item) =>
        ['serious', 'critical'].includes(item.impact ?? ''),
      ),
    ).toEqual([])
    await page.screenshot({
      path: info.outputPath(`rejected-learning-${width}.png`),
      fullPage: true,
    })
    await page.goto('/dev-fixtures/rejected-learning-evaluation?empty=1')
    await expect(page.getByRole('button', { name: 'Prepare immutable case' })).toHaveCount(0)
    await expect(page.getByText(/No .*insights|No .*evidence|No .*candidates/)).toBeVisible()
  })
}
