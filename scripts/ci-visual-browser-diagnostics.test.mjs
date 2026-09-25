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
    /- name: Verify phone, tablet, and desktop core-product rendering[\s\S]*?(?=\n\s+- name: Retain text-first visitor fixture screenshots)/u,
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

test('the unchanged bundle build gate reports bounded compiler diagnostics before the long browser suite', async () => {
  const build = workflow.indexOf('- name: Build and verify browser bundles contain no server secrets')
  const visual = workflow.indexOf('- name: Verify phone, tablet, and desktop core-product rendering')
  assert.ok(build >= 0 && build < visual)
  assert.equal(workflow.match(/run: pnpm verify:client-bundles/gu)?.length, 1)
  const verifier = await readFile(path.join(root, 'scripts/verify-client-bundle-secrets.mjs'), 'utf8')
  const diagnosticWriter = await readFile(
    path.join(root, 'scripts/lib/client-bundle-build-diagnostic.mjs'),
    'utf8',
  )
  assert.match(verifier, /process\.env\.GITHUB_ACTIONS === 'true'/u)
  assert.match(verifier, /writeClientBundleBuildDiagnostic\(\{ result, application, stdout: process\.stdout \}\)/u)
  assert.match(diagnosticWriter, /createDiagnosticAnnotation\([\s\S]*80,[\s\S]*8_000,/u)
  assert.match(diagnosticWriter, /::error title=Client bundle build failed::/u)
  assert.match(verifier, /process\.exitCode = reportOperatorCliFailure/u)
  assert.doesNotMatch(verifier, /console\.(?:error|log)\(result\.(?:stdout|stderr)\)/u)
})

test('held final recovery and API contracts execute before the broad visual gate', async () => {
  const visual = workflow.indexOf('- name: Verify phone, tablet, and desktop core-product rendering')
  for (const name of [
    'Verify final combined visitor denial, Stop, draft and recovery contracts',
    'Verify final combined chat API conversation and replay contracts',
  ]) {
    const start = workflow.indexOf(`- name: ${name}`)
    assert.ok(start >= 0 && start < visual, `${name} must run before the broad visual gate`)
    const step = workflow.slice(start).split(/\n\s+- name:/u)[0]
    assert.match(step, /vitest run/u)
    assert.match(step, /--pool=forks --maxWorkers=1/u)
    assert.doesNotMatch(step, /continue-on-error|passWithNoTests|\|\|\s*true/u)
    const command = step.match(/run: pnpm --dir (\S+) exec vitest run (.+)/u)
    assert.ok(command)
    const files = command[2].split(/\s+/u).filter((argument) => !argument.startsWith('--'))
    assert.ok(files.length > 0)
    for (const file of files) {
      assert.ok((await readFile(path.join(root, command[1], file), 'utf8')).length > 0)
    }
  }
  assert.match(workflow, /components\/VenueChatExperience\.test\.tsx/u)
  assert.match(workflow, /components\/ChatWindow\.test\.tsx/u)
  assert.match(workflow, /src\/routers\/chat\.test\.ts/u)
})

test('guest-visit browser proof asserts profile absence rather than reopening a removed form', async () => {
  const spec = await readFile(path.join(root, 'apps/dashboard/tests/visual/guest-visit.spec.ts'), 'utf8')
  assert.match(spec, /function expectNoVisitForm/u)
  assert.match(spec, /includeHidden: true/u)
  assert.match(spec, /toHaveCount\(0\)/u)
  assert.match(spec, /toBeEditable\(\)/u)
  assert.match(spec, /assertChatLayout\(page\)/u)
  assert.doesNotMatch(spec, /summary\.focus\(\)|openPreferences\(|\.skip\(/u)
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
