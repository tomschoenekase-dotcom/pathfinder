import {
  auth,
  hasStrictReverification,
  strictReverificationRequiredBody,
} from '@pathfinder/auth/server'
import {
  isOperatorApprover,
  resolveOperatorConfig,
  type OperatorServerConfig,
} from '@pathfinder/api/operator'

export type OperatorSessionResolution =
  | { status: 'disabled' }
  | { status: 'misconfigured' }
  | { status: 'forbidden' }
  | { status: 'ok'; config: OperatorServerConfig; userId: string }

/**
 * The human half of the operator: a signed-in PLATFORM_ADMIN whose user ID is on the operator
 * allowlist. Every consent and approval handler calls this before reading its body.
 */
export async function resolveOperatorSession(): Promise<OperatorSessionResolution> {
  const resolution = resolveOperatorConfig()
  if (resolution.status === 'disabled') return { status: 'disabled' }
  if (resolution.status === 'misconfigured') return { status: 'misconfigured' }
  const { userId, sessionClaims } = await auth()
  const platformRole = (sessionClaims?.publicMetadata as { platform_role?: unknown } | undefined)
    ?.platform_role
  if (!userId || !isOperatorApprover(resolution.config, { userId, platformRole })) {
    return { status: 'forbidden' }
  }
  return { status: 'ok', config: resolution.config, userId }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Shared guard for state-changing operator POSTs: same-origin, allowlisted admin, and a strict
 * Clerk reverification. The 403 body is Clerk's hint so `useReverification` prompts Face ID or a
 * passkey and retries.
 */
export async function guardOperatorMutation(
  request: Request,
): Promise<{ response: Response } | { config: OperatorServerConfig; userId: string }> {
  const session = await resolveOperatorSession()
  if (session.status === 'disabled') return { response: json(404, { error: 'NOT_FOUND' }) }
  if (session.status === 'misconfigured') {
    return { response: json(503, { error: 'OPERATOR_UNAVAILABLE' }) }
  }
  if (session.status === 'forbidden') return { response: json(403, { error: 'FORBIDDEN' }) }
  if (request.headers.get('origin') !== session.config.issuer) {
    return { response: json(403, { error: 'FORBIDDEN_ORIGIN' }) }
  }
  if (!(await hasStrictReverification())) {
    return { response: json(403, strictReverificationRequiredBody()) }
  }
  return { config: session.config, userId: session.userId }
}

export { json as operatorJson }
