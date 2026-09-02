import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { createDiagnosticAnnotation, createDiagnosticTail } from './lib/ci-diagnostic-tail.mjs'

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

let finalized = false
function fail(outcome) {
  if (finalized) return
  finalized = true
  process.stderr.write(
    `Workspace test graph failed with ${outcome}. Sanitized final output follows.\n`,
  )
  const annotation = createDiagnosticAnnotation(tail.values())
  process.stderr.write(`::error title=Workspace test graph failed::${annotation}\n`)
  process.exitCode = 1
}

child.once('error', () => {
  tail.push('Unable to start workspace tests')
  fail('startup failure')
})

// `exit` can fire before the stdio streams are fully drained. Finalize on `close`
// so the diagnostic tail includes the child's last assertion or stack line.
child.once('close', (code, signal) => {
  if (code === 0 && signal === null) {
    finalized = true
    return
  }
  fail(signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`)
})
