import {
  parseVenueRefreshArgs,
  runVenueRefreshCommand,
  VenueRefreshError,
} from '../lib/embedding-venue-refresh-cli'
import { writeSafeCliFailure } from '../lib/safe-cli-failure'

async function main(): Promise<void> {
  const command = parseVenueRefreshArgs(process.argv.slice(2), process.env)
  const result = await runVenueRefreshCommand(command)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error: unknown) => {
  writeSafeCliFailure({
    action: 'embedding.refresh-venue.failed',
    errorCode: 'embedding-refresh-venue-failed',
  })
  // Only this command's own guard messages are printed; database and provider errors are not.
  if (error instanceof VenueRefreshError) process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
