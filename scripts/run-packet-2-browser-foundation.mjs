import { spawnSync } from 'node:child_process'
import process from 'node:process'

const pnpmCli = process.env.npm_execpath
if (!pnpmCli) {
  throw new Error('pnpm must invoke this script so its CLI path is available')
}
const suites = [
  {
    label: 'Admin OS, Internal Workspace, and ultra-simple client portal DOM contracts',
    args: [
      '--dir',
      'apps/dashboard',
      'exec',
      'vitest',
      'run',
      'components/admin/AdminSectionShell.test.tsx',
      'components/admin/ClientWorkspaceShell.test.tsx',
      'components/DashboardOverview.test.tsx',
      'components/PacketSurfaceStates.test.tsx',
      'app/(app)/analytics/page.test.tsx',
      'app/(app)/legacy-route-boundary.test.ts',
    ],
  },
  {
    label: 'Guest route, responsive presentation, and structured response DOM contracts',
    args: [
      '--dir',
      'apps/web',
      'exec',
      'vitest',
      'run',
      'app/[venueSlug]/chat/page.test.tsx',
      'app/[venueSlug]/chat/layout.test.tsx',
      'app/embed/[venueSlug]/page.test.tsx',
      'components/VenueChatExperience.test.tsx',
      'components/ResponseRenderer.test.tsx',
    ],
  },
]

for (const suite of suites) {
  console.log(`\n[packet-2 browser foundation] ${suite.label}`)
  const result = spawnSync(process.execPath, [pnpmCli, ...suite.args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('\nPacket 2 local browser-foundation contracts passed.')
