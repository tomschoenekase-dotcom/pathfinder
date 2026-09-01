import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { validateFounderEvidencePackage } from './validate-lib.mjs'

const args = process.argv.slice(2)
if (args.length !== 1 || args[0] === '--help') {
  console.error('Usage: pnpm founder-evidence:validate -- <path-to-founder-approved-package.json>')
  process.exit(args[0] === '--help' ? 0 : 2)
}

try {
  const inputPath = await realpath(path.resolve(args[0])).catch(() => null)
  if (!inputPath) throw new Error('Founder evidence package does not exist')
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const receipt = await validateFounderEvidencePackage(input, {
    packageDirectory: path.dirname(inputPath),
  })
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  const safeMessage =
    error instanceof Error && error.message.startsWith('Founder evidence package rejected:')
      ? error.message
      : 'Founder evidence package rejected: unreadable or invalid package'
  console.error(safeMessage)
  process.exitCode = 1
}
