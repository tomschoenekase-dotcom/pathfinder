import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const testFiles = (await readdir(scriptsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => path.join(scriptsDirectory, entry.name))
  .sort()

if (testFiles.length === 0) {
  throw new Error('No repository script tests were discovered')
}

const requestedConcurrency = process.env.TORCHIKO_SCRIPT_TEST_CONCURRENCY
if (requestedConcurrency !== undefined && !/^[1-9]\d*$/u.test(requestedConcurrency)) {
  throw new Error('TORCHIKO_SCRIPT_TEST_CONCURRENCY must be a positive integer')
}
const concurrencyArgs = requestedConcurrency ? [`--test-concurrency=${requestedConcurrency}`] : []

const child = spawn(process.execPath, ['--test', ...concurrencyArgs, ...testFiles], {
  shell: false,
  stdio: 'inherit',
})

child.once('error', () => {
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
