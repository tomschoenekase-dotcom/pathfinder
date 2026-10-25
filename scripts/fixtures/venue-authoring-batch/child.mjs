// Fictional process fixture only. This renderer is never selected by the batch CLI.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [mode, ...args] = process.argv.slice(2)
if (mode === 'fail') {
  process.stderr.write('Fictional child failure\n')
  process.exitCode = 7
} else if (mode === 'sleep') setTimeout(() => {}, 60000)
else if (mode === 'tree') {
  const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'inherit',
    windowsHide: true,
  })
  process.stdout.write(`${descendant.pid}\n`)
  setTimeout(() => {}, 60000)
} else if (mode === 'echo') process.stdout.write(JSON.stringify(args))
else if (mode === 'preview') {
  const [packageFile, output] = args
  const metric = { mode: 'FULL', renderedChars: 50, maxFullChars: 120000, rendererTruncated: false }
  writeFileSync(
    output,
    JSON.stringify({
      schemaVersion: 1,
      scope: 'CREATE_ONLY_PACKAGE_PREVIEW',
      packageSha256: createHash('sha256').update(readFileSync(packageFile)).digest('hex'),
      default: metric,
      evidence: metric,
    }),
    { flag: 'wx' },
  )
} else throw new Error('Unknown fixture mode')
