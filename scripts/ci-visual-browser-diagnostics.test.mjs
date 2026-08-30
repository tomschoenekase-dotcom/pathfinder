import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
const visualConfig = await readFile(
  path.join(root, 'apps/dashboard/playwright.visual.config.ts'),
  'utf8',
)
const dashboardLayout = await readFile(path.join(root, 'apps/dashboard/app/layout.tsx'), 'utf8')

test('responsive browser CI failures retain a bounded secret-free diagnostic tail', () => {
  const step = workflow.match(
    /- name: Verify phone, tablet, and desktop core-product rendering[\s\S]*?(?=\n\s+- name: Build and verify browser bundles)/u,
  )?.[0]

  assert.ok(step)
  assert.match(step, /set -o pipefail/u)
  assert.match(step, /visual_log="\$\(mktemp\)"/u)
  assert.match(step, /pnpm test:visual-browser 2>&1 \| tee "\$visual_log"/u)
  assert.match(step, /tail -n 80 "\$visual_log"/u)
  assert.match(step, /::error title=Responsive browser gate failed::\$safe_line/u)
  assert.match(step, /line\/\/'%'\/'%25'/u)
  assert.doesNotMatch(step, /printenv|env\s|set\s+-x|DATABASE_URL|SECRET|TOKEN/iu)
})

test('visual fixtures bypass Clerk only through an explicit development-only server contract', () => {
  assert.match(visualConfig, /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:\s*''/u)
  assert.match(visualConfig, /TORCHIKO_VISUAL_FIXTURES_ENABLED:\s*'1'/u)
  assert.match(
    dashboardLayout,
    /process\.env\.NODE_ENV === 'development'[\s\S]*TORCHIKO_VISUAL_FIXTURES_ENABLED === '1'/u,
  )
  assert.match(
    dashboardLayout,
    /if \(!publishableKey\)[\s\S]*if \(fixtureWithoutClerk\) return document/u,
  )
  assert.match(
    dashboardLayout,
    /throw new Error\('Dashboard authentication configuration is unavailable'\)/u,
  )
  assert.match(dashboardLayout, /<ClerkProvider[\s\S]*publishableKey=\{publishableKey\}/u)
  assert.doesNotMatch(workflow, /^\s+NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:/mu)
})
