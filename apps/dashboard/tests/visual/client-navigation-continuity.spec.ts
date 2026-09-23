import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const venueId = 'fixture-great-lakes-museum'
const baseUrl = process.env.PLAYWRIGHT_DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3001'
const onboarding = `/venues/${venueId}/onboarding`
const support = `/support?venue=${venueId}&returnTo=${encodeURIComponent(onboarding)}`

for (const viewport of [
  { name: 'phone-320', width: 320, height: 568 },
  { name: 'tablet-820', width: 820, height: 1180 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const) {
  test(`keeps the selected venue through onboarding, request, Today, and QR at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'phone-390x844',
      'This test explicitly covers four viewport sizes.',
    )
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const mutations: Array<Record<string, unknown>> = []
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.route('**/api/trpc/**', async (route) => {
      const url = new URL(route.request().url())
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        mutations.push(body)
        if (url.pathname.includes('support.createRequest')) {
          const result = {
            data: {
              json: {
                request: {
                  id: 'fixture-request',
                  venueId,
                  category: 'GENERAL',
                  status: 'OPEN',
                  subject: 'Update the family arrival note',
                  missingInformation: [],
                  clientVersion: 1,
                  clientActivityAt: '2026-09-08T12:00:00.000Z',
                  requesterIsCurrentUser: true,
                  participantIsCurrentUser: true,
                  canReply: true,
                  statusChangedAt: '2026-09-08T12:00:00.000Z',
                  createdAt: '2026-09-08T12:00:00.000Z',
                },
                message: {
                  id: 'fixture-message',
                  authorKind: 'CLIENT',
                  authorIsCurrentUser: true,
                  body: 'Please review the arrival wording for families.',
                  createdAt: '2026-09-08T12:00:00.000Z',
                  attachments: [],
                },
              },
            },
          }
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(url.searchParams.get('batch') === '1' ? [{ result }] : { result }),
          })
          return
        }
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ result: { data: { json: null } } }),
      })
    })

    await page.goto(
      `${baseUrl}/dev-fixtures/client-navigation?target=${encodeURIComponent(onboarding)}`,
    )
    await expect(page.getByRole('heading', { name: 'Share venue materials' })).toBeVisible()
    const nav = page.getByRole('navigation', { name: 'Client portal navigation' })
    if (viewport.width < 1024) {
      const drawer = page.getByRole('button', { name: 'Open navigation' })
      await drawer.focus()
      await expect(drawer).toBeFocused()
      await drawer.click()
    }
    expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-onboarding-navigation.png`),
      fullPage: true,
    })
    const supportLink = nav.getByRole('link', { name: 'Questions & help' })
    await expect(supportLink).toHaveAttribute('href', support)
    await supportLink.focus()
    await expect(supportLink).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeFocused()

    await page.getByRole('button', { name: 'New request' }).first().click()
    await page.getByLabel('Subject').fill('Update the family arrival note')
    await page.getByLabel('Message').fill('Please review the arrival wording for families.')
    await page.getByRole('button', { name: 'Send request' }).click()
    await expect(page.getByText(/submitted for review/iu)).toBeVisible()
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.['0']).toMatchObject({
      json: {
        venueId,
        category: 'GENERAL',
        subject: 'Update the family arrival note',
        body: 'Please review the arrival wording for families.',
        attachments: [],
      },
    })

    if (viewport.width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click()
    const today = nav.getByRole('link', { name: 'Today' })
    await expect(today).toHaveAttribute('href', `/?venue=${venueId}`)
    await today.click()
    await expect(
      page.getByText('Great Lakes Discovery Museum', { exact: true }).first(),
    ).toBeVisible()
    expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-today.png`),
      fullPage: true,
    })
    const qrLink = page.getByRole('link', { name: 'Open QR code' })
    await expect(qrLink).toHaveAttribute('href', `/venues/${venueId}/qr-kit`)
    await qrLink.click()
    await expect(
      page.getByRole('heading', { name: 'Great Lakes Discovery Museum QR code' }),
    ).toBeVisible()
    await expect(
      page.getByText('https://guide.example.com/great-lakes-discovery-museum/chat'),
    ).toBeVisible()
    if (viewport.width < 1024) await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute(
      'href',
      `/?venue=${venueId}`,
    )

    if (viewport.width < 1024) {
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused()
    }
    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1)
    expect((await new AxeBuilder({ page }).include('body').analyze()).violations).toEqual([])
    expect(pageErrors).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}.png`), fullPage: true })
  })
}
