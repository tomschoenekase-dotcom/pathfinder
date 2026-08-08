import {
  inspectTerminalJobRedrive,
  redriveTerminalJob,
  type TerminalJobRecordEvidence,
  type TerminalRedriveQueue,
} from '@pathfinder/jobs'

const ALLOWED_ARGUMENTS = new Set(['--actor-id', '--confirm', '--execute', '--job-id', '--queue'])
const EXECUTION_OPT_IN = 'staging-terminal-redrive'

export type TerminalRedriveCommand = {
  actorId: string
  queueName: string
  bullJobId: string
  execute: boolean
  confirmationToken?: string
}

type AuditInput = {
  tenantId?: string | null
  actorId: string
  actorRole: string
  action: string
  targetType: string
  targetId: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
}

export type TerminalRedriveCommandDependencies = {
  queue: TerminalRedriveQueue
  loadEvidence(params: {
    queue: string
    bullJobId: string
  }): Promise<TerminalJobRecordEvidence | null>
  writeAuditLog(params: AuditInput): Promise<void>
}

export class TerminalRedrivePostMutationAuditError extends Error {
  readonly mutationAccepted = true
}

export class TerminalRedriveCleanupAggregateError extends AggregateError {
  readonly mutationAccepted: boolean

  constructor(errors: unknown[], message: string, mutationAccepted: boolean) {
    super(errors, message)
    this.mutationAccepted = mutationAccepted
  }
}

export function terminalRedriveMutationWasAccepted(error: unknown): boolean {
  return (
    error instanceof TerminalRedrivePostMutationAuditError ||
    (typeof error === 'object' &&
      error !== null &&
      'mutationAccepted' in error &&
      error.mutationAccepted === true)
  )
}

export function terminalRedriveFinalError(params: {
  primaryError: unknown
  cleanupFailures: unknown[]
  commandExecuted: boolean
}): unknown {
  const mutationAccepted =
    params.commandExecuted || terminalRedriveMutationWasAccepted(params.primaryError)
  if (params.primaryError !== undefined && params.cleanupFailures.length > 0) {
    return new TerminalRedriveCleanupAggregateError(
      [params.primaryError, ...params.cleanupFailures],
      'Terminal redrive and cleanup both failed',
      mutationAccepted,
    )
  }
  if (params.primaryError !== undefined) return params.primaryError
  if (params.cleanupFailures.length > 0) {
    return new TerminalRedriveCleanupAggregateError(
      params.cleanupFailures,
      'Terminal redrive cleanup failed',
      mutationAccepted,
    )
  }
  return undefined
}

function readArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments; invalid token ${key ?? '<missing>'}`)
    }
    if (!ALLOWED_ARGUMENTS.has(key)) throw new Error(`Unknown argument ${key}`)
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`)
    values.set(key, value)
  }
  return values
}

export function parseTerminalRedriveArgs(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): TerminalRedriveCommand {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Terminal redrive is staging-only until a separate production gate is approved')
  }
  const args = readArguments(argv)
  const actorId = args.get('--actor-id')
  const queueName = args.get('--queue')
  const bullJobId = args.get('--job-id')
  if (!actorId || !queueName || !bullJobId) {
    throw new Error('Terminal redrive requires --actor-id, --queue, and --job-id')
  }
  const executeValue = args.get('--execute')
  if (executeValue !== undefined && executeValue !== 'true') {
    throw new Error('--execute accepts only the exact value true')
  }
  const execute = executeValue === 'true'
  const confirmationToken = args.get('--confirm')
  if (!execute && confirmationToken !== undefined) {
    throw new Error('--confirm is accepted only with --execute true')
  }
  if (execute && !confirmationToken) {
    throw new Error('Execution requires the current preview --confirm token')
  }
  if (execute && environment.PATHFINDER_ALLOW_TERMINAL_REDRIVE !== EXECUTION_OPT_IN) {
    throw new Error(`Execution requires PATHFINDER_ALLOW_TERMINAL_REDRIVE=${EXECUTION_OPT_IN}`)
  }
  return {
    actorId,
    queueName,
    bullJobId,
    execute,
    ...(confirmationToken ? { confirmationToken } : {}),
  }
}

export async function runTerminalRedriveCommand(
  command: TerminalRedriveCommand,
  environment: NodeJS.ProcessEnv,
  dependencies: TerminalRedriveCommandDependencies,
) {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Terminal redrive execution requires RAILWAY_ENVIRONMENT=staging')
  }
  if (dependencies.queue.name !== command.queueName) {
    throw new Error('Constructed queue identity does not match the command')
  }
  const evidence = await dependencies.loadEvidence({
    queue: command.queueName,
    bullJobId: command.bullJobId,
  })
  const inspected = await inspectTerminalJobRedrive({
    queue: dependencies.queue,
    bullJobId: command.bullJobId,
    evidence,
  })
  if (!evidence) throw new Error('Terminal redrive evidence disappeared after inspection')
  if (!command.execute) {
    return { mode: 'preview' as const, ...inspected.preview }
  }
  if (environment.PATHFINDER_ALLOW_TERMINAL_REDRIVE !== EXECUTION_OPT_IN) {
    throw new Error('Terminal redrive runtime opt-in is absent')
  }

  const targetId = `${command.queueName}/${command.bullJobId}`
  await dependencies.writeAuditLog({
    tenantId: evidence?.tenantId,
    actorId: command.actorId,
    actorRole: 'OPERATOR',
    action: 'JOB_TERMINAL_REDRIVE_REQUESTED',
    targetType: 'JobRecord',
    targetId,
    beforeState: {
      status: 'FAILED',
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
      terminalAt: inspected.preview.terminalAt,
      attemptNumber: inspected.preview.attemptsMade,
      attemptsStarted: inspected.preview.attemptsStarted,
      maxAttempts: inspected.preview.maxAttempts,
      payloadDigest: inspected.preview.payloadDigest,
    },
  })

  const preview = await redriveTerminalJob({
    queue: dependencies.queue,
    bullJobId: command.bullJobId,
    evidence,
    confirmationToken: command.confirmationToken!,
  })
  try {
    await dependencies.writeAuditLog({
      tenantId: evidence?.tenantId,
      actorId: command.actorId,
      actorRole: 'OPERATOR',
      action: 'JOB_TERMINAL_REDRIVE_ACCEPTED',
      targetType: 'JobRecord',
      targetId,
      afterState: {
        bullMqTransition: 'failed-to-waiting',
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      },
    })
  } catch (error) {
    throw new TerminalRedrivePostMutationAuditError(
      'BullMQ accepted the redrive, but the acceptance audit could not be persisted; inspect before retrying',
      { cause: error },
    )
  }
  return { mode: 'executed' as const, ...preview }
}
