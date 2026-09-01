import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { validatePhysicalEvidencePackage } from './validate-lib.mjs'

const args = process.argv.slice(2)
if (args.length !== 1 || args[0] === '--help') {
  console.error('Usage: pnpm physical-evidence:validate -- <path-to-reviewed-package.json>')
  process.exit(args[0] === '--help' ? 0 : 2)
}

try {
  const requestedPath = path.resolve(args[0])
  const metadata = await lstat(requestedPath).catch(() => null)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576)
    throw new Error('Physical evidence package is not a bounded regular file')
  const inputPath = await realpath(requestedPath)
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  const receipt = await validatePhysicalEvidencePackage(input, {
    packageDirectory: path.dirname(inputPath),
  })
  console.log(JSON.stringify(receipt, null, 2))
} catch (error) {
  const safeMessage =
    error instanceof Error && error.message.startsWith('Physical evidence package rejected:')
      ? error.message
      : 'Physical evidence package rejected: unreadable or invalid package'
  console.error(safeMessage)
  process.exitCode = 1
}
