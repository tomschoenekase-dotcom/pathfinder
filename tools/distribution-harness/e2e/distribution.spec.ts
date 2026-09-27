import { expect, test } from '../../../apps/dashboard/node_modules/@playwright/test'

const webOrigin = process.env.TORCHIKO_DISTRIBUTION_WEB_ORIGIN ?? 'http://127.0.0.1:4173'
const fixtureOrigin = process.env.TORCHIKO_DISTRIBUTION_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4174'
const venue = process.env.TORCHIKO_DISTRIBUTION_VENUE ?? 'city-sc'

function fixturePath(mode: string, origin = fixtureOrigin) {
  const params = new URLSearchParams({ webOrigin, venue })
  return `${origin}/${mode}?${params.toString()}`
}

test.beforeEach(async ({ request }) => {
  await request.post(`${webOrigin}/__test_state`, { data: { state: 'active' } })
})

test.afterEach(async ({ request }) => {
  await request.post(`${webOrigin}/__test_state`, { data: { state: 'active' } })
})

test('@stub admitted host opens the cross-origin frame and preserves its browser session on reopen', async ({
  page,
}) => {
  await page.goto(fixturePath('launcher'))
  const launcher = page.locator('.pf-launcher')
  await expect(launcher).toBeVisible({ timeout: 15_000 })
  expect(new URL(page.url()).origin).toBe(fixtureOrigin)
  expect(new URL(webOrigin).origin).not.toBe(fixtureOrigin)
  await launcher.click()

  const frame = page.locator('iframe[data-pathfinder-widget-frame]')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  await expect(frame).toHaveAttribute('src', new RegExp(`/embed/${venue}$`))
  await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/)
  await expect(frame).toHaveAttribute('allow', 'microphone')
  const chat = page.frameLocator('iframe[data-pathfinder-widget-frame]')
  await expect(chat.getByRole('heading', { name: 'CITY SC visitor guide' })).toBeVisible()
  await chat.getByRole('textbox', { name: 'Question' }).fill('Where is the visitor desk?')
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(chat.locator('#count')).toHaveText('1')

  await page.getByRole('button', { name: /close/i }).click()
  await expect(launcher).toBeVisible()
  await launcher.click()
  await expect(frame).toBeVisible()
  await expect(chat.locator('#count')).toHaveText('1')
})

test('@stub inline mount stays in its container and has no launcher', async ({ page }) => {
  await page.goto(fixturePath('inline'))
  const container = page.locator('[data-torchiko-inline]')
  const frame = container.locator('iframe[data-pathfinder-widget-frame]')
  await expect(frame).toBeVisible({ timeout: 15_000 })
  await expect(frame).toHaveAttribute('src', new RegExp(`/embed/${venue}/inline$`))
  await expect(page.locator('.pf-launcher')).toHaveCount(0)
})

test('@stub unadmitted host fails invisible and frame policy names only the admitted origin', async ({
  page,
}) => {
  const unadmittedOrigin = fixtureOrigin.replace('127.0.0.1', 'localhost')
  await page.goto(fixturePath('unadmitted', unadmittedOrigin))
  await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('[data-torchiko-inline] iframe')).toHaveCount(0)

  const policyResponse = await page.request.get(`${webOrigin}/embed/${venue}`)
  expect(policyResponse.headers()['content-security-policy']).toBe(
    `frame-ancestors 'self' ${fixtureOrigin}`,
  )
})

for (const state of ['revoked', 'disabled', 'paused'] as const) {
  test(`@stub ${state} policy makes the website fixture fail invisible`, async ({
    page,
    request,
  }) => {
    await request.post(`${webOrigin}/__test_state`, { data: { state } })
    await page.goto(fixturePath('launcher'))
    await expect(page.locator('[data-pathfinder-widget]')).toHaveCount(0, { timeout: 15_000 })
  })
}
