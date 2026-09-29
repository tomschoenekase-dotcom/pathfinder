import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

const PASS_FIXTURE =
  '/dev-fixtures/visitor-chat?presentation=webview&appHeader=none&mode=classic&conversation=pass'

type NativeWindow = Window & { __torchikoNativeMessages?: unknown[] }

test.beforeEach(async ({ page }) => {
  // Stand in for react-native-webview's injected channel, as a partner app would provide it.
  await page.addInitScript(() => {
    const target = window as NativeWindow & {
      ReactNativeWebView?: { postMessage: (message: string) => void }
    }
    target.__torchikoNativeMessages = []
    target.ReactNativeWebView = {
      postMessage: (message) => target.__torchikoNativeMessages?.push(JSON.parse(message)),
    }
  })
})

test('an opted-in app host gets an open-in-app button that sends only the place', async ({
  page,
}, testInfo) => {
  await page.goto(`${PASS_FIXTURE}&placeAction=Open%20in%20app`)
  const places = page.getByLabel('Recommended places')
  await expect(places.getByRole('article')).toHaveCount(3)
  const aquarium = page.getByRole('button', { name: 'Open in app: Harbor Aquarium' })
  await expect(aquarium).toBeVisible()
  await expect(page.getByRole('button', { name: /^Open in app: / })).toHaveCount(3)
  expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true)
  const axe = await new AxeBuilder({ page }).include('main').analyze()
  expect(axe.violations).toEqual([])
  await aquarium.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('app-place-action.png'), fullPage: false })

  await aquarium.click()
  const messages = await page.evaluate(() => (window as NativeWindow).__torchikoNativeMessages)
  // The app bridge announces itself first; the tap adds exactly one place action.
  expect(messages).toEqual([
    { source: 'torchiko', v: 1, type: 'ready', payload: null },
    { source: 'torchiko', v: 1, type: 'open', payload: null },
    {
      source: 'torchiko',
      v: 1,
      type: 'place-action',
      payload: { placeId: 'fixture-pass-aquarium', name: 'Harbor Aquarium' },
    },
  ])
  expect(JSON.stringify(messages)).not.toContain('two kids')
})

test('without the host opt-in, app visitors see no host button and no image-free cards', async ({
  page,
}) => {
  await page.goto(PASS_FIXTURE)
  await expect(
    page.getByText('Start at the Harbor Aquarium when it opens', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Open in app/ })).toHaveCount(0)
  await expect(page.getByLabel('Recommended places')).toHaveCount(0)
})

test('a native "ask about this" injection fills the live guide composer without sending', async ({
  page,
}) => {
  await page.goto(`${PASS_FIXTURE}&placeAction=1`)
  await expect(page.getByRole('button', { name: 'Open in app: Harbor Aquarium' })).toBeVisible()
  // Hosts inject only after the guide's `ready` message, which follows listener setup.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as NativeWindow).__torchikoNativeMessages?.some(
          (message) => (message as { type: string }).type === 'ready',
        ),
      ),
    )
    .toBe(true)
  // What react-native-webview's injectJavaScript or WKWebView.evaluateJavaScript would run.
  await page.evaluate(() =>
    window.postMessage(
      {
        source: 'torchiko',
        v: 1,
        type: 'prefill',
        payload: { ask: 'Is the shark tunnel good for toddlers?', place: 'fixture-pass-aquarium' },
      },
      window.location.origin,
    ),
  )
  await expect(page.locator('textarea')).toHaveValue('Is the shark tunnel good for toddlers?')
  const messages = await page.evaluate(() => (window as NativeWindow).__torchikoNativeMessages)
  expect(messages?.map((message) => (message as { type: string }).type)).toEqual(['ready', 'open'])
})

test('a partner label is shown as given and an oversized label is ignored', async ({ page }) => {
  await page.goto(`${PASS_FIXTURE}&placeAction=See%20in%20pass`)
  await expect(
    page.getByRole('button', { name: 'See in pass: Skyline Observation Deck' }),
  ).toBeVisible()
  await page.goto(`${PASS_FIXTURE}&placeAction=${'x'.repeat(33)}`)
  await expect(
    page.getByText('Start at the Harbor Aquarium when it opens', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /: Harbor Aquarium$/ })).toHaveCount(0)
})
