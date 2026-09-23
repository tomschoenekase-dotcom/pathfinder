import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

for (const font of ['jakarta', 'inter', 'poppins', 'spaceGrotesk', 'dmSans', 'playfair']) {
  test(`loads the selected ${font} font without preloading the customization catalog`, async ({
    page,
  }, testInfo) => {
    const response = await page.goto(
      `/dev-fixtures/visitor-chat?mode=classic&conversation=long&font=${font}`,
    )
    await expect(page.getByRole('heading', { name: 'Great Lakes Discovery Museum' })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const evidence = await page
      .getByRole('heading', { name: 'Great Lakes Discovery Museum' })
      .evaluate((heading) => {
        const family = getComputedStyle(heading)
          .fontFamily.split(',')[0]!
          .replace(/["']/gu, '')
          .trim()
        const loadedFaces = Array.from(document.fonts).filter(
          (face) => face.family.replace(/["']/gu, '') === family && face.status === 'loaded',
        )
        return {
          family,
          loadedFaces: loadedFaces.length,
          loadedFamilies: [
            ...new Set(
              Array.from(document.fonts)
                .filter((face) => face.status === 'loaded')
                .map((face) => face.family.replace(/["']/gu, '')),
            ),
          ].sort(),
          fontResources: performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => /\.(?:woff2?|ttf)(?:\?|$)/u.test(name)),
          domPreloadCount: document.querySelectorAll('link[rel="preload"][as="font"]').length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        }
      })
    expect(evidence.loadedFaces, JSON.stringify(evidence)).toBeGreaterThan(0)
    const customizationFamilies = [
      'Inter',
      'Poppins',
      'Space Grotesk',
      'DM Sans',
      'Playfair Display',
    ]
    expect(
      evidence.loadedFamilies.filter(
        (family) => customizationFamilies.includes(family) && family !== evidence.family,
      ),
      JSON.stringify({ ...evidence, link: response?.headers().link ?? null }),
    ).toEqual([])
    // Next development mode omits preloads; production may preload the default
    // family. Retain header/DOM evidence without treating that mode difference
    // as a failure. The fetched-resource bound catches loading the whole catalog.
    await testInfo.attach('font-loading-evidence', {
      body: JSON.stringify({ ...evidence, link: response?.headers().link ?? null }),
      contentType: 'application/json',
    })
    expect(evidence.fontResources.length, JSON.stringify(evidence)).toBeLessThanOrEqual(5)
    expect(evidence.overflow).toBe(false)
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(accessibility.violations).toEqual([])
    await page
      .locator('nextjs-portal')
      .evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
    await page.screenshot({ path: testInfo.outputPath(`visitor-font-${font}.png`), fullPage: true })
  })
}
