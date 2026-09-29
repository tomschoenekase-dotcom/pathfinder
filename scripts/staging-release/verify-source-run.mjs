import { spawnSync } from 'node:child_process'
import { assertSourceRun } from './restore-provenance.mjs'
import { safeErrorCode } from './error-code.mjs'

try {
  const [runId, releaseSha] = process.argv.slice(2)
  if (process.argv.length !== 4 || !/^[1-9][0-9]*$/u.test(runId ?? '') ||
      !/^[a-f0-9]{40}$/u.test(releaseSha ?? '') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(process.env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('invalid-source-run-input')
  }
  const result = spawnSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`],
    { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (result.status !== 0) throw new Error('source-run-read-failed')
  const run = JSON.parse(result.stdout)
  assertSourceRun(run, releaseSha)
  process.stdout.write('source-run-verified\n')
} catch (error) {
  const code = safeErrorCode(error, ['invalid-source-run-input', 'source-run-read-failed', 'untrusted-source-run'], 'source-run-invalid-response')
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
  process.exitCode = 1
}
