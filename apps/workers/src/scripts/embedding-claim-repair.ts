import {
  parseEmbeddingClaimRepairArgs,
  runEmbeddingClaimRepairCommand,
} from '../lib/embedding-claim-repair-cli'
import { writeSafeCliFailure } from '../lib/safe-cli-failure'

async function main(): Promise<void> {
  const command = parseEmbeddingClaimRepairArgs(process.argv.slice(2), process.env)
  const result = await runEmbeddingClaimRepairCommand(command)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch(() => {
  writeSafeCliFailure({
    action: 'embedding.claim-repair.failed',
    errorCode: 'embedding-claim-repair-failed',
  })
  process.exitCode = 1
})
