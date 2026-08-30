import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SAFE_OPERATION = /^[a-z0-9][a-z0-9-]{0,95}$/u

export function disposableRunnerFailureRecord(error, entrypointUrl) {
  const basename = path.basename(fileURLToPath(entrypointUrl), '.mjs')
  const candidate = basename.replace(/^run-disposable-/u, '')
  const operation = SAFE_OPERATION.test(candidate) ? candidate : 'operation'
  const refusal = error instanceof Error && error.constructor.name.endsWith('Refusal')
  const cleanupFailure = error instanceof AggregateError
  return {
    ok: false,
    action: `disposable.${operation}.failed`,
    errorCode: refusal
      ? 'disposable-runner-refused'
      : cleanupFailure
        ? 'disposable-runner-cleanup-failed'
        : 'disposable-runner-failed',
  }
}

export function reportDisposableRunnerFailure(
  error,
  entrypointUrl,
  stderr = process.stderr,
) {
  const record = disposableRunnerFailureRecord(error, entrypointUrl)
  stderr.write(`${JSON.stringify(record)}\n`)
  return record.errorCode === 'disposable-runner-refused' ? 2 : 1
}
