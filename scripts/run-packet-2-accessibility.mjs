import { spawnSync } from 'node:child_process'
import process from 'node:process'

const pnpmCli = process.env.npm_execpath
if (!pnpmCli) {
  throw new Error('pnpm must invoke this script so its CLI path is available')
}

const suites = [
  {
    label: 'Admin OS, Internal Workspace, and client portal axe contracts',
    directory: 'apps/dashboard',
    testFile: 'components/PacketAccessibility.test.tsx',
  },
  {
    label: 'Guest response axe contracts',
    directory: 'apps/web',
    testFile: 'components/PacketAccessibility.test.tsx',
  },
  {
    label: 'Guest route planner axe contract',
    directory: 'apps/web',
    testFile: 'components/LocationRoutePlanner.test.tsx',
  },
  {
    label: 'Stripe billing client axe contracts',
    directory: 'apps/dashboard',
    testFile: 'components/billing/ClientBillingView.test.tsx',
  },
  {
    label: 'Stripe billing operator axe contracts',
    directory: 'apps/dashboard',
    testFile: 'components/admin/AdminBillingView.test.tsx',
  },
  {
    label: 'Stripe billing portfolio and CRM axe contracts',
    directory: 'apps/dashboard',
    testFile: 'components/admin/AdminBillingPortfolio.test.tsx',
  },
]

for (const suite of suites) {
  console.log(`\n[packet-2 accessibility] ${suite.label}`)
  const result = spawnSync(
    process.execPath,
    [pnpmCli, '--dir', suite.directory, 'exec', 'vitest', 'run', suite.testFile],
    { cwd: process.cwd(), stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('\nPacket 2 local axe accessibility contracts passed.')
