import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('Packet 2 accessibility gate stays CI-wired across all four product surfaces', async () => {
  const [packageJson, workflow, runner, dashboardTest, guestTest] = await Promise.all([
    read('package.json'),
    read('.github/workflows/ci.yml'),
    read('scripts/run-packet-2-accessibility.mjs'),
    read('apps/dashboard/components/PacketAccessibility.test.tsx'),
    read('apps/web/components/PacketAccessibility.test.tsx'),
  ])

  assert.match(
    packageJson,
    /"test:accessibility": "node scripts\/run-packet-2-accessibility\.mjs"/u,
  )
  assert.match(workflow, /run: pnpm test:accessibility/u)
  assert.match(runner, /apps\/dashboard/u)
  assert.match(runner, /apps\/web/u)
  assert.match(dashboardTest, /AdminSectionShell/u)
  assert.match(dashboardTest, /ClientWorkspaceShell/u)
  assert.match(dashboardTest, /client portal live and loading states/u)
  assert.match(guestTest, /structured guest answer/u)
  assert.match(guestTest, /VenueChatShell/u)
  assert.match(guestTest, /standalone guest chat shell/u)
  assert.match(dashboardTest, /DashboardShell/u)
  assert.match(dashboardTest, /axe\.run\(document/u)
  assert.match(guestTest, /axe\.run\(document/u)
  assert.match(dashboardTest, /'color-contrast': \{ enabled: false \}/u)
  assert.match(guestTest, /'color-contrast': \{ enabled: false \}/u)
})
