import path from 'node:path'

import {
  createStagingHandoffManifest,
  parseStagingHandoffArgs,
} from './lib/staging-handoff-manifest.mjs'
import { reportOperatorCliFailure } from './lib/operator-cli-failure.mjs'

const root = path.resolve(import.meta.dirname, '..')

try {
  const options = parseStagingHandoffArgs(process.argv.slice(2))
  const result = await createStagingHandoffManifest({ root, options })
  process.stdout.write(
    `${JSON.stringify({
      status: result.manifest.admission.status,
      report: path.relative(root, result.outputPath).replaceAll('\\', '/'),
      sha256: result.sha256,
    })}\n`,
  )
} catch {
  process.exitCode = reportOperatorCliFailure({
    action: 'staging-handoff.failed',
    errorCode: 'staging-handoff-failed',
  })
}
