import {
  parseEmbeddingClaimRepairArgs,
  runEmbeddingClaimRepairCommand,
} from '../lib/embedding-claim-repair-cli'

async function main(): Promise<void> {
  const command = parseEmbeddingClaimRepairArgs(process.argv.slice(2), process.env)
  const result = await runEmbeddingClaimRepairCommand(command)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exitCode = 1
})
