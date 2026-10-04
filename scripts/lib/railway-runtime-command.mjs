import { RAILWAY_CLI_PACKAGE } from './railway-cli-contract.mjs'

export function railwayRuntimeCommand({ platform, nodeExecutable, pnpmEntry, queryArgs }) {
  const args = ['dlx', RAILWAY_CLI_PACKAGE, ...queryArgs,
    '--project', '8621111a-4ac8-4d88-9566-4627c8a02059']
  // Linux pnpm may be a launcher/standalone executable, not a Node script.
  // Execute the installed command directly without a shell.
  if (platform !== 'win32') return { executable: 'pnpm', args }
  if (typeof pnpmEntry !== 'string' || !/[/\\]pnpm\.c?js$/iu.test(pnpmEntry)) {
    throw new Error('node-compatible-pnpm-entry-required')
  }
  return { executable: nodeExecutable, args: [pnpmEntry, ...args] }
}
