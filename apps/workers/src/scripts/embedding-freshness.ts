import {
  parseEmbeddingFreshnessArgs,
  runEmbeddingFreshnessCommand,
} from '../lib/embedding-freshness-cli'
import { writeSafeCliFailure } from '../lib/safe-cli-failure'

async function main(): Promise<void> {
  const command = parseEmbeddingFreshnessArgs(process.argv.slice(2), process.env)
  const result = await runEmbeddingFreshnessCommand(command)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch(() => {
  writeSafeCliFailure({
    action: 'embedding.freshness.failed',
    errorCode: 'embedding-freshness-failed',
  })
  process.exitCode = 1
})
