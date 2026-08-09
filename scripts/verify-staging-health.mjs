import {
  parseStagingHealthArgs,
  StagingHealthAdmissionError,
  verifyStagingHealth,
} from './lib/staging-health-admission.mjs'

try {
  const result = await verifyStagingHealth(parseStagingHealthArgs(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  const code = error instanceof StagingHealthAdmissionError ? error.code : 'unexpected-failure'
  process.stderr.write(`Staging health admission failed: ${code}\n`)
  process.exitCode = 1
}
