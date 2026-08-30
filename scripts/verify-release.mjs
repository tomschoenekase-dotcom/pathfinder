import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  createReleaseProgressReporter,
  parseReleaseVerificationArgs,
  runReleaseVerification,
} from './lib/release-verification.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')

async function repositoryState() {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
    execFileAsync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
  ])
  return { revision: revision.trim(), clean: status.trim() === '' }
}

try {
  const options = parseReleaseVerificationArgs(process.argv.slice(2))
  const result = await runReleaseVerification({
    root,
    profile: options.profile,
    requestedRevision: options.revision,
    reportPath: options.report,
    repositoryState,
    progressReporter: createReleaseProgressReporter(process.stderr),
  })
  process.stdout.write(
    `${JSON.stringify({
      readiness: result.report.readiness,
      report: path.relative(root, result.jsonPath),
      markdown: path.relative(root, result.markdownPath),
    })}\n`,
  )
  if (result.report.readiness === 'not-ready') process.exitCode = 1
} catch {
  process.exitCode = reportOperatorCliFailure({
    action: 'release-verification.failed',
    errorCode: 'release-verification-failed',
  })
}
