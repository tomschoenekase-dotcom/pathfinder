import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createDiagnosticTail, sanitizeDiagnosticLine } from './lib/ci-diagnostic-tail.mjs'

const tail = createDiagnosticTail(120)
const windows = process.platform === 'win32'
const executable = windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm'
const args = windows
  ? ['/d', '/s', '/c', 'pnpm exec turbo run test --concurrency=2 --output-logs=full']
  : ['exec', 'turbo', 'run', 'test', '--concurrency=2', '--output-logs=full']

const child = spawn(executable, args, {
  env: process.env,
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
})

for (const stream of [child.stdout, child.stderr]) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  lines.on('line', (line) => {
    tail.push(line)
    process.stdout.write(`${line}\n`)
  })
}

child.once('error', (error) => {
  tail.push(`Unable to start workspace tests: ${error.message}`)
})

child.once('exit', (code, signal) => {
  if (code === 0 && signal === null) return

  const outcome = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
  process.stderr.write(`Workspace test graph failed with ${outcome}. Sanitized final output follows.\n`)
  for (const line of tail.values()) {
    process.stderr.write(
      `::error title=Workspace test graph failed::${sanitizeDiagnosticLine(line)}\n`,
    )
  }
  process.exitCode = 1
})
