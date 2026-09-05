import path from 'node:path'

import {
  finalizeStagingHandoff,
  parseStagingHandoffFinalizeArgs,
} from './lib/staging-handoff-manifest.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

const root = path.resolve(import.meta.dirname, '..')

try {
  const options = parseStagingHandoffFinalizeArgs(process.argv.slice(2))
  const result = await finalizeStagingHandoff({ root, options })
  process.stdout.write(
    `${JSON.stringify({
      status: result.manifest.admission.status,
      ownerRevision: result.manifest.admission.ownerRevision,
      report: path.relative(root, result.outputPath).replaceAll('\\', '/'),
      sha256: result.sha256,
    })}\n`,
  )
} catch {
  process.exitCode = reportOperatorCliFailure({
    action: 'staging-handoff-finalization.failed',
    errorCode: 'staging-handoff-finalization-failed',
  })
}
