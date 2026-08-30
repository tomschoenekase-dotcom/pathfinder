const SAFE_ACTION = /^[a-z][a-z0-9.-]{2,127}$/u
const SAFE_ERROR_CODE = /^[a-z][a-z0-9-]{2,95}$/u

export function reportOperatorCliFailure({
  action,
  errorCode,
  exitCode = 1,
  stderr = process.stderr,
}) {
  if (!SAFE_ACTION.test(action)) throw new Error('Operator failure action must be a safe code.')
  if (!SAFE_ERROR_CODE.test(errorCode))
    throw new Error('Operator failure errorCode must be a safe code.')
  if (exitCode !== 1 && exitCode !== 2)
    throw new Error('Operator failure exitCode must be either 1 or 2.')

  stderr.write(`${JSON.stringify({ ok: false, action, errorCode })}\n`)
  return exitCode
}
