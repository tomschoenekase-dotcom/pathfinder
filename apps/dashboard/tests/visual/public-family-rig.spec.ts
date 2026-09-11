import { readFileSync } from 'node:fs'
import path from 'node:path'

import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Route } from '@playwright/test'

const dashboardBaseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const origin = new URL(dashboardBaseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Public family rig proof requires an isolated loopback dashboard')
}

const repositoryRoot = process.cwd().endsWith(path.join('apps', 'dashboard'))
  ? path.resolve(process.cwd(), '../..')
  : process.cwd()
const fixtureRoot = path.join(repositoryRoot, 'packages/character-factory/fixtures')
const fixtureAssets = new Map([
  ['source/owl.svg', readFileSync(path.join(fixtureRoot, 'source/owl.svg'))],
  ['layers/body.svg', readFileSync(path.join(fixtureRoot, 'segmented/owl/body.svg'))],
  ['layers/wing.svg', readFileSync(path.join(fixtureRoot, 'segmented/owl/wing.svg'))],
  ['layers/face.svg', readFileSync(path.join(fixtureRoot, 'segmented/owl/face.svg'))],
])

test.use({ serviceWorkers: 'block' })

for (const viewport of [
  { name: 'phone-320x740', width: 320, height: 740 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
]) {
  test(`public family rig renderer is bounded at ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    await page.setViewportSize(viewport)
    const pageErrors: string[] = []
    const externalAttempts: string[] = []
    const pending: Route[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== origin.origin) {
        externalAttempts.push(`${url.origin}${url.pathname}`)
        await route.abort('blockedbyclient')
        return
      }
      const match = url.pathname.match(
        /^\/characters\/custom\/public-family-rig-([^/]+)\/v\d+\/(source\/owl\.svg|layers\/(?:body|wing|face)\.svg)$/,
      )
      if (!match) {
        await route.continue()
        return
      }
      const [, identity, assetPath] = match
      if (identity === 'delayed-a') {
        pending.push(route)
        return
      }
      if (
        identity === 'failure-double' ||
        (identity === 'failure-layer' && assetPath?.startsWith('layers/'))
      ) {
        await route.fulfill({ status: 404, contentType: 'image/svg+xml', body: '' })
        return
      }
      const bytes = fixtureAssets.get(assetPath ?? '')
      if (!bytes) throw new Error(`Unexpected family fixture asset: ${assetPath ?? '<missing>'}`)
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: bytes })
    })

    const stage = page.getByRole('region', { name: 'Published family rig fixture' })
    const frame = page.locator('[data-character-family-frame]')

    async function navigate(query: string) {
      await page.goto(`${dashboardBaseUrl}/dev-fixtures/public-family-rig?${query}`, {
        waitUntil: 'domcontentloaded',
      })
      await expect(stage).toHaveAttribute('data-fixture-ready', 'true')
    }

    async function expectHealthyLayers(state: 'idle' | 'speaking') {
      const rig = page.getByRole('img', { name: `Prepared neutral owl: ${state}` })
      await expect(rig).toBeVisible()
      await expect(rig.locator('[data-rig-layer]')).toHaveCount(3)
      await expect
        .poll(() =>
          rig.locator('img').evaluateAll((images) =>
            images.every((image) => {
              const element = image as HTMLImageElement
              return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
            }),
          ),
        )
        .toBe(true)
    }

    async function expectGeometry() {
      const metrics = await page.evaluate(() => {
        const fixture = document.querySelector<HTMLElement>('[data-fixture-ready]')!
        const familyFrame = document.querySelector<HTMLElement>('[data-character-family-frame]')!
        const rig = document.querySelector<HTMLElement>('[data-rig-family]')!
        const card = familyFrame.parentElement!
        const rect = familyFrame.getBoundingClientRect()
        const rigRect = rig.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        return {
          frame: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          rig: { x: rigRect.x, y: rigRect.y, width: rigRect.width, height: rigRect.height },
          card: { x: cardRect.x, y: cardRect.y, width: cardRect.width, height: cardRect.height },
          fixtureWidth: fixture.getBoundingClientRect().width,
          overflow:
            document.documentElement.scrollWidth > window.innerWidth + 1 ||
            document.body.scrollWidth > window.innerWidth + 1,
        }
      })
      expect(metrics.frame.width).toBeGreaterThan(40)
      expect(metrics.frame.height).toBeGreaterThan(40)
      expect(Math.abs(metrics.frame.width / metrics.frame.height - 1)).toBeLessThan(0.02)
      expect(Math.abs(metrics.rig.width - metrics.frame.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(metrics.rig.height - metrics.frame.height)).toBeLessThanOrEqual(1)
      expect(metrics.frame.x).toBeGreaterThanOrEqual(metrics.card.x - 1)
      expect(metrics.frame.x + metrics.frame.width).toBeLessThanOrEqual(
        metrics.card.x + metrics.card.width + 1,
      )
      expect(metrics.fixtureWidth).toBeLessThanOrEqual(viewport.width)
      expect(metrics.overflow).toBe(false)
    }

    async function expectStaticGeometry() {
      const fallback = page.locator('[data-character-fallback="pack"]')
      const box = await fallback.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThan(40)
      expect(box!.height).toBeGreaterThan(40)
      expect(Math.abs(box!.width / box!.height - 1)).toBeLessThan(0.02)
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
      ).toBe(false)
    }

    async function screenshot(name: string) {
      const image = await page.screenshot({
        path: testInfo.outputPath(`${name}.png`),
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
      })
      expect(image.byteLength).toBeGreaterThan(8_000)
    }

    try {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await navigate('state=speaking&motion=full&size=stage')
      await expectHealthyLayers('speaking')
      await expectGeometry()
      await screenshot('full-speaking')

      await navigate('state=question&motion=full&size=stage')
      await expectHealthyLayers('idle')
      await expect(page.locator('[data-rig-state="idle"]')).toHaveCount(1)
      await expect(page.locator('[data-rendered-state]')).toHaveText('idle')

      await navigate('state=speaking&motion=reduced&size=stage')
      await expect(stage).toHaveAttribute('data-fixture-errors', '0')
      await expect(page.locator('[data-character-fallback="pack"] img')).toHaveAttribute(
        'src',
        /\/source\/owl\.svg$/,
      )
      await expect(frame).toHaveCount(0)
      await expectStaticGeometry()

      await page.emulateMedia({ reducedMotion: 'reduce' })
      await navigate('state=speaking&motion=system&size=stage')
      await expect(page.locator('[data-resolved-motion]')).toHaveText('reduced')
      await expect(page.locator('[data-character-fallback="pack"] img')).toHaveAttribute(
        'src',
        /\/source\/owl\.svg$/,
      )
      await expectStaticGeometry()
      await screenshot('system-reduced')

      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await navigate('state=error&motion=full&size=stage&failure=layer')
      await expect(stage).toHaveAttribute('data-fixture-errors', '1')
      await expect(page.locator('[data-character-fallback="pack"] img')).toHaveAttribute(
        'src',
        /\/source\/owl\.svg$/,
      )
      await expect(frame).toHaveCount(0)
      await expectStaticGeometry()

      await navigate('state=error&motion=full&size=stage&failure=double')
      await expect(stage).toHaveAttribute('data-fixture-errors', '2')
      await expect(page.locator('[data-character-fallback="brand"]')).toContainText('Torchiko')
      await expect(page.locator('[data-character-fallback="brand"] img')).toHaveCount(0)
      await screenshot('neutral-double-failure')

      await navigate('state=speaking&motion=full&size=stage&proof=isolation')
      await expectHealthyLayers('speaking')
      await page.getByRole('button', { name: 'Use delayed identity' }).click()
      await expect.poll(() => pending.length).toBe(3)
      await page.getByRole('button', { name: 'Publish replacement identity' }).click()
      await expect(stage).toHaveAttribute('data-fixture-asset-pack', 'prepared-neutral-b')
      await expectHealthyLayers('speaking')
      for (const route of pending.splice(0)) {
        await route.fulfill({ status: 404, contentType: 'image/svg+xml', body: '' })
      }
      await page.getByRole('button', { name: 'Deliver retired errors' }).click()
      await expect(stage).toHaveAttribute('data-fixture-late-deliveries', '3')
      await expect(stage).toHaveAttribute('data-fixture-errors', '0')
      await expectHealthyLayers('speaking')
      await expectGeometry()
      await screenshot('replacement-after-retired-errors')

      const violations = (await new AxeBuilder({ page }).include('main').analyze()).violations
      expect(violations).toEqual([])
      expect(pageErrors).toEqual([])
      expect(externalAttempts).toEqual([])
    } finally {
      await Promise.allSettled(pending.map((route) => route.abort()))
    }
  })
}
