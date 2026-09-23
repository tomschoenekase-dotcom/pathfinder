import { readFile } from 'node:fs/promises'

import jsQR from 'jsqr'
import sharp from 'sharp'
import { expect, test } from '@playwright/test'

const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'

async function decodeSvg(svgBytes: Buffer): Promise<string | undefined> {
  const { data, info } = await sharp(svgBytes)
    .resize(832, 832, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  return jsQR(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    info.width,
    info.height,
    { inversionAttempts: 'attemptBoth' },
  )?.data
}

function skipTablet(testInfo: { project: { name: string } }) {
  test.skip(
    testInfo.project.name === 'tablet-820x1180',
    'FM08 browser export proof targets the requested phone and desktop widths.',
  )
}

test.describe('QR SVG export proof', () => {
  test('downloads reusable SVG bytes that decode to the exact venue URL', async ({
    page,
  }, testInfo) => {
    skipTablet(testInfo)
    await page.goto(`${baseUrl}/dev-fixtures/qr-kit`)
    await expect(page.getByRole('heading', { name: 'Harbor House QR code' })).toBeVisible()

    const targets = ['Harbor House visitor guide']
    for (const label of targets) {
      const button = page.getByRole('button', { name: `Download SVG for ${label}` })
      const card = page.locator('article').filter({ has: button })
      const expectedUrl = (await card.locator('p.font-mono').textContent())?.trim()
      expect(expectedUrl).toBeTruthy()

      const firstDownload = page.waitForEvent('download')
      await button.click()
      const download = await firstDownload
      const filename = download.suggestedFilename()
      expect(filename).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/)
      const artifactPath = testInfo.outputPath(`qr-export-${filename}`)
      await download.saveAs(artifactPath)
      const bytes = await readFile(artifactPath)
      expect(bytes.toString('utf8')).toContain('<svg')
      await expect.poll(() => decodeSvg(bytes)).toBe(expectedUrl)

      const secondDownload = page.waitForEvent('download')
      await button.click()
      const retry = await secondDownload
      const retryPath = testInfo.outputPath(`retry-${filename}`)
      await retry.saveAs(retryPath)
      expect(await readFile(retryPath)).toEqual(bytes)
    }

    await expect(page.getByText(/save this QR code for signs and handouts/i).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('qr-export-proof.png'), fullPage: true })
  })

  test('shows a recoverable failure and keeps it off printed collateral', async ({
    page,
  }, testInfo) => {
    skipTablet(testInfo)
    await page.addInitScript(() => {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: () => {
          throw new Error('synthetic export failure')
        },
      })
    })
    await page.goto(`${baseUrl}/dev-fixtures/qr-kit`)
    const button = page.getByRole('button', {
      name: 'Download SVG for Harbor House visitor guide',
    })
    await button.click()
    const error = page.locator('p[role="alert"]')
    await expect(error).toContainText('could not be downloaded')
    await expect(error).toHaveClass(/print:hidden/)
    await page.screenshot({ path: testInfo.outputPath('qr-export-failure.png'), fullPage: true })
  })
})
