import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

test('shows the visitor guide in Look & feel at phone and desktop widths', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(`${dashboardBaseUrl}/dev-fixtures/client-portal?page=look`, {
      waitUntil: 'networkidle',
    })
    await expect(page.getByRole('heading', { name: 'Look & feel' })).toBeVisible()
    const previewTab = page.getByRole('tab', { name: 'Preview' })
    if (await previewTab.isVisible()) await previewTab.click()

    const preview = page.getByTitle('Preview of the Maple Hollow Nature Center visitor guide')
    await expect(preview).toBeVisible()
    await expect(preview).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin')
    await expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(preview).toHaveAttribute('src', /\/appearance-preview\?embed=1/u)

    const visitorFrame = page.frameLocator(
      'iframe[title="Preview of the Maple Hollow Nature Center visitor guide"]',
    )
    await expect(visitorFrame.locator('[data-preview-embedded="true"]')).toBeVisible()
    const renderedGuide = visitorFrame.locator('[data-fixture="visitor-chat"]')
    await expect(renderedGuide).toBeVisible()
    await expect(renderedGuide).toHaveAttribute('data-fixture-mode', 'classic')
    await expect(renderedGuide).toHaveAttribute('data-fixture-conversation', 'placeholder')
    await expect(
      visitorFrame.getByRole('heading', {
        name: 'Maple Hollow Nature Center',
        exact: true,
      }),
    ).toBeVisible()
    await expect(visitorFrame.getByText('Lorem ipsum dolor sit amet?')).toBeVisible()

    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(widths).toEqual({ viewport: viewport.width, document: viewport.width })

    const previewFrame = page.frames().find((frame) => {
      try {
        return new URL(frame.url()).pathname === '/appearance-preview'
      } catch {
        return false
      }
    })
    expect(previewFrame).toBeDefined()
    const previewWidths = await previewFrame!.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(previewWidths.document).toBeLessThanOrEqual(previewWidths.viewport)

    const axe = await new AxeBuilder({ page }).include('body').analyze()
    expect(axe.violations).toEqual([])

    const screenshot = testInfo.outputPath(`look-and-feel-preview-${viewport.width}.png`)
    const guideScreenshot = testInfo.outputPath(`look-and-feel-guide-${viewport.width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await page
      .locator(
        'figure:has(iframe[title="Preview of the Maple Hollow Nature Center visitor guide"])',
      )
      .screenshot({ path: guideScreenshot })
    await testInfo.attach(`look-and-feel-preview-${viewport.width}`, {
      path: screenshot,
      contentType: 'image/png',
    })
    await testInfo.attach(`look-and-feel-guide-${viewport.width}`, {
      path: guideScreenshot,
      contentType: 'image/png',
    })
  }
})
