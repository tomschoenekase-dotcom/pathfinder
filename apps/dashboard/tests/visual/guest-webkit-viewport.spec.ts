import { expect, test } from '@playwright/test'

const visitorBaseUrl = process.env.PLAYWRIGHT_VISITOR_BASE_URL ?? 'http://127.0.0.1:3000'

test.use({ hasTouch: true })

test('focused guest composer remains reachable when the viewport shrinks', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390x844', 'phone keyboard-height proxy runs once')
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  await page.goto(
    `${visitorBaseUrl}/dev-fixtures/visitor-chat?mode=character&state=idle&conversation=long&motion=reduced&voice=none`,
  )
  await page.locator('nextjs-portal').evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  await expect(page.locator('[data-fixture="visitor-chat"]')).toHaveAttribute(
    'data-fixture-client-mounted',
    'true',
  )

  const composer = page.getByRole('textbox', { name: 'Ask a question' })
  await composer.focus()
  await composer.fill(
    'Where is the quiet gallery? Please avoid the main stairs and include somewhere to rest. We are visiting with children.',
  )
  await page.setViewportSize({ width: 390, height: 430 })
  await expect(composer).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()

  const geometry = await composer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      visible:
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.left >= 0 &&
        rect.right <= window.innerWidth,
      hit: target === element || element.contains(target),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    }
  })
  expect(geometry).toEqual({ visible: true, hit: true, overflow: false })
  await page.screenshot({ path: testInfo.outputPath('guest-focused-390x430.png') })
  await page.getByRole('button', { name: 'Send message' }).tap()
  await expect(composer).toHaveValue('')

  await page.setViewportSize({ width: 390, height: 844 })
  await composer.focus()
  await composer.fill('One more question')
  await expect(composer).toBeFocused()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  expect(runtimeErrors).toEqual([])
})
