import { Queue } from 'bullmq'

import { assertServerEnv, env } from '@pathfinder/config'
import { db, findTerminalJobRecordEvidence, writeAuditLogStrict } from '@pathfinder/db'
import { closeBullMQConnection, getBullMQConnection } from '@pathfinder/jobs'

import {
  parseTerminalRedriveArgs,
  runTerminalRedriveCommand,
  terminalRedriveFinalError,
  terminalRedriveMutationWasAccepted,
} from '../lib/terminal-redrive-cli'

async function main(): Promise<void> {
  assertServerEnv(['REDIS_URL'], 'terminal-redrive')
  const command = parseTerminalRedriveArgs(process.argv.slice(2), process.env)
  const queue = new Queue(command.queueName, { connection: getBullMQConnection() })
  let result: Awaited<ReturnType<typeof runTerminalRedriveCommand>> | undefined
  let primaryError: unknown
  try {
    result = await runTerminalRedriveCommand(command, process.env, {
      queue,
      loadEvidence: findTerminalJobRecordEvidence,
      writeAuditLog: writeAuditLogStrict,
    })
  } catch (error) {
    primaryError = error
  }
  const closed = await Promise.allSettled([
    queue.close(),
    closeBullMQConnection(),
    db.$disconnect(),
  ])
  const cleanupFailures = closed.flatMap((closeResult) =>
    closeResult.status === 'rejected' ? [closeResult.reason] : [],
  )
  const finalError = terminalRedriveFinalError({
    primaryError,
    cleanupFailures,
    commandExecuted: result?.mode === 'executed',
  })
  if (finalError !== undefined) throw finalError
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      mutationAccepted: terminalRedriveMutationWasAccepted(error),
      error: error instanceof Error ? error.message : 'Unknown terminal redrive failure',
      environment: env.RAILWAY_ENVIRONMENT,
    })}\n`,
  )
  process.exitCode = 1
})
