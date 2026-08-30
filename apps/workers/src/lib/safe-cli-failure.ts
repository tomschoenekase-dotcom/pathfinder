type SafeCliFailure = {
  action: string
  errorCode: string
  mutationAccepted?: boolean
  environment?: string
}

type Writable = {
  write(chunk: string): unknown
}

const SAFE_ACTION = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,127}$/u
const SAFE_ENVIRONMENTS = new Set(['development', 'test', 'staging', 'production'])

export function serializeSafeCliFailure(failure: SafeCliFailure): string {
  const payload = {
    ok: false,
    action: SAFE_ACTION.test(failure.action) ? failure.action : 'cli.failed',
    errorCode: SAFE_ERROR_CODE.test(failure.errorCode) ? failure.errorCode : 'cli-operation-failed',
    ...(failure.mutationAccepted === undefined
      ? {}
      : { mutationAccepted: failure.mutationAccepted }),
    ...(failure.environment && SAFE_ENVIRONMENTS.has(failure.environment)
      ? { environment: failure.environment }
      : {}),
  }
  return `${JSON.stringify(payload)}\n`
}

export function writeSafeCliFailure(
  failure: SafeCliFailure,
  stream: Writable = process.stderr,
): void {
  stream.write(serializeSafeCliFailure(failure))
}
