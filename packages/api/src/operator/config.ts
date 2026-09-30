import { env } from '@pathfinder/config'

import {
  parsePepperKeyring,
  type OperatorPepperKeyring,
  type OperatorTokenEnvironment,
} from './tokens'

export const OPERATOR_MCP_PATH = '/api/operator/mcp'
export const OPERATOR_OAUTH_SCOPE = 'operator'

/** Lifetimes are fixed in code, not configuration, so a typo cannot widen them. */
export const OPERATOR_OAUTH_LIFETIMES = {
  codeSeconds: 60,
  // Plan §3.3 asks for 15 minutes when the client refreshes. Whether ChatGPT refreshes is
  // unverified (plan §5.8), so the plan's fallback applies. Every call still re-reads the grant,
  // so revocation remains immediate whatever this lifetime is.
  accessSeconds: 60 * 60,
  refreshIdleSeconds: 7 * 24 * 60 * 60,
  refreshAbsoluteSeconds: 30 * 24 * 60 * 60,
  unconsentedClientSeconds: 24 * 60 * 60,
  maxGrantDays: 90,
  proposalHours: 72,
} as const

export type OperatorServerConfig = Readonly<{
  /** Dashboard origin, e.g. https://app.torchiko.com. Never derived from request headers. */
  issuer: string
  /** The exact protected resource and access-token audience. */
  resource: string
  environment: OperatorTokenEnvironment
  keyring: OperatorPepperKeyring
  redirectOrigins: ReadonlySet<string>
  allowedUserIds: ReadonlySet<string>
}>

export type OperatorConfigResolution =
  | { status: 'disabled' }
  | { status: 'misconfigured'; reason: string }
  | { status: 'ready'; config: OperatorServerConfig }

type OperatorEnvironmentSource = Readonly<{
  OPERATOR_OAUTH_ENABLED?: boolean | undefined
  OPERATOR_OAUTH_ISSUER?: string | undefined
  OPERATOR_OAUTH_PEPPERS?: string | undefined
  OPERATOR_OAUTH_REDIRECT_ORIGINS?: string | undefined
  OPERATOR_OAUTH_ALLOWED_USER_IDS?: string | undefined
  RAILWAY_ENVIRONMENT?: string | undefined
}>

function isLoopbackHost(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/** An exact origin: scheme + host (+ port), https unless loopback, nothing else. */
export function parseExactOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  if (!secure || url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (value.replace(/\/$/u, '') !== url.origin) return null
  return url.origin
}

function list(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function resolveOperatorConfig(
  source: OperatorEnvironmentSource = env,
): OperatorConfigResolution {
  if (source.OPERATOR_OAUTH_ENABLED !== true) return { status: 'disabled' }
  const issuer = source.OPERATOR_OAUTH_ISSUER
    ? parseExactOrigin(source.OPERATOR_OAUTH_ISSUER)
    : null
  if (!issuer) return { status: 'misconfigured', reason: 'ISSUER' }
  let keyring: OperatorPepperKeyring
  try {
    keyring = parsePepperKeyring(source.OPERATOR_OAUTH_PEPPERS)
  } catch {
    return { status: 'misconfigured', reason: 'PEPPERS' }
  }
  const allowedUserIds = new Set(list(source.OPERATOR_OAUTH_ALLOWED_USER_IDS))
  if (allowedUserIds.size === 0) return { status: 'misconfigured', reason: 'ALLOWED_USER_IDS' }
  const redirectOrigins = new Set<string>()
  for (const entry of list(source.OPERATOR_OAUTH_REDIRECT_ORIGINS)) {
    const origin = parseExactOrigin(entry)
    if (!origin || !origin.startsWith('https://')) {
      return { status: 'misconfigured', reason: 'REDIRECT_ORIGINS' }
    }
    redirectOrigins.add(origin)
  }
  return {
    status: 'ready',
    config: {
      issuer,
      resource: `${issuer}${OPERATOR_MCP_PATH}`,
      environment: source.RAILWAY_ENVIRONMENT === 'production' ? 'prd' : 'stg',
      keyring,
      redirectOrigins,
      allowedUserIds,
    },
  }
}

export function protectedResourceMetadataUrl(config: Pick<OperatorServerConfig, 'issuer'>) {
  return `${config.issuer}/.well-known/oauth-protected-resource${OPERATOR_MCP_PATH}`
}

export function approveUrl(config: Pick<OperatorServerConfig, 'issuer'>, id: string) {
  return `${config.issuer}/approve/${encodeURIComponent(id)}`
}
