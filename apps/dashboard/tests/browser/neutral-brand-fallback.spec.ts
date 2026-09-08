import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const viewports = [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const

const surfaces = [
  { name: 'today', path: '/dev-fixtures/portal-home?state=live' },
  { name: 'onboarding', path: '/dev-fixtures/remote-onboarding?state=share' },
  { name: 'loading', path: '/dev-fixtures/neutral-brand-fallback?surface=loading' },
  { name: 'error', path: '/dev-fixtures/neutral-brand-fallback?surface=error' },
] as const

for (const viewport of viewports) {
  test(`neutral fallback stays restrained across client surfaces at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })

    for (const surface of surfaces) {
      await page.goto(surface.path)
      await expect(page.locator('[class*="core"] svg')).toHaveCount(0)
      const wordmarks = page.locator('[class*="coreWordmark"]')
      if (surface.name === 'error') {
        await expect(wordmarks).toHaveCount(0)
        await page.getByRole('button').first().focus()
        await expect(page.getByRole('button').first()).toBeFocused()
      } else {
        await expect(wordmarks.first()).toHaveText('Torchiko')
        await expect(wordmarks.first()).toHaveAttribute('aria-hidden', 'true')
      }
      if (surface.name === 'today') {
        const wordmarkBox = await wordmarks.first().boundingBox()
        const footerBox = await page
          .getByText('Right now', { exact: true })
          .locator('..')
          .boundingBox()
        expect(wordmarkBox).not.toBeNull()
        expect(footerBox).not.toBeNull()
        expect(wordmarkBox!.y + wordmarkBox!.height).toBeLessThan(footerBox!.y)
      }
      const dimensions = await page.evaluate(() => ({
        body: document.body.scrollWidth,
        viewport: innerWidth,
      }))
      expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1)
      const axe = await new AxeBuilder({ page }).include('body').analyze()
      expect(axe.violations).toEqual([])
      await page.screenshot({
        path: `artifacts/neutral-brand-fallback/${surface.name}-${viewport.name}-${testInfo.project.name}.png`,
        fullPage: true,
      })
    }
  })
}
