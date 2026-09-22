// Server-only: node:crypto cannot be bundled into a Next browser entry. Keep this
// module out of client.ts; configuration is deployment-owned, never metadata.
import { createHash } from 'node:crypto'

type Kind = 'user' | 'organization'
type Pair = { providerId: string; applicationId: string }
type Binding = {
  version: 1
  issuer: string
  instanceId: string
  webhookSecretSha256: string
  users: Pair[]
  organizations: Pair[]
}

function invalid(): never {
  // Never include configuration, provider keys or request values in errors.
  throw new Error('Clerk identity binding validation failed')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid()
}

function pairs(value: unknown, prefix: string): Pair[] {
  if (!Array.isArray(value) || value.length > 100) invalid()
  const sources = new Set<string>()
  const targets = new Set<string>()
  const result = value.map((item: unknown) => {
    const pair = record(item)
    exactKeys(pair, ['providerId', 'applicationId'])
    const { providerId, applicationId } = pair
    const pattern = new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`, 'u')
    if (
      typeof providerId !== 'string' ||
      typeof applicationId !== 'string' ||
      !pattern.test(providerId) ||
      !pattern.test(applicationId) ||
      sources.has(providerId) ||
      targets.has(applicationId)
    )
      invalid()
    sources.add(providerId)
    targets.add(applicationId)
    return { providerId, applicationId }
  })
  // Reject identity entries, chains and cycles. An ID has exactly one meaning.
  if ([...sources].some((id) => targets.has(id))) invalid()
  return result
}

function readBinding(): Binding | null {
  const raw = process.env.CLERK_IDENTITY_BINDING
  if (raw === undefined) {
    // Production must never silently onboard replacement provider IDs after
    // a missed deployment setting. Unconfigured staging retains its old IDs.
    if (process.env.RAILWAY_ENVIRONMENT === 'production') invalid()
    return null
  }
  if (raw.length > 64 * 1024) invalid()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    invalid()
  }
  const value = record(parsed)
  exactKeys(value, [
    'version',
    'issuer',
    'instanceId',
    'webhookSecretSha256',
    'users',
    'organizations',
  ])
  if (
    value.version !== 1 ||
    typeof value.issuer !== 'string' ||
    !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/u.test(value.issuer) ||
    typeof value.instanceId !== 'string' ||
    !/^ins_[A-Za-z0-9]+$/u.test(value.instanceId) ||
    typeof value.webhookSecretSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.webhookSecretSha256)
  )
    invalid()
  const keys = [
    process.env.CLERK_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  ].filter((key): key is string => key !== undefined)
  if (!keys.length || !process.env.CLERK_SECRET_KEY?.startsWith('sk_live_')) invalid()
  for (const key of keys) {
    if (!/^pk_live_[A-Za-z0-9+/]+={0,2}$/u.test(key)) invalid()
    const encoded = key.slice('pk_live_'.length)
    const decoded = Buffer.from(encoded, 'base64')
    if (
      decoded.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '') ||
      decoded.toString('utf8') !== `${new URL(value.issuer).hostname}$`
    )
      invalid()
  }
  return {
    version: 1,
    issuer: value.issuer,
    instanceId: value.instanceId,
    webhookSecretSha256: value.webhookSecretSha256,
    users: pairs(value.users, 'user'),
    organizations: pairs(value.organizations, 'org'),
  }
}

export function assertClerkSessionBinding(claims: unknown): void {
  const binding = readBinding()
  if (binding && record(claims).iss !== binding.issuer) invalid()
}

/** Call only after Svix verifies the original body with the deployment secret. */
export function assertClerkWebhookBinding(event: unknown, secret: string): void {
  const binding = readBinding()
  if (!binding) return
  if (
    record(event).instance_id !== binding.instanceId ||
    createHash('sha256').update(secret, 'utf8').digest('hex') !== binding.webhookSecretSha256
  )
    invalid()
}

function translate(kind: Kind, id: string, direction: 'incoming' | 'outgoing'): string {
  const binding = readBinding()
  if (!binding) return id
  const prefix = kind === 'user' ? 'user' : 'org'
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`, 'u').test(id)) invalid()
  const entries = kind === 'user' ? binding.users : binding.organizations
  const from = direction === 'incoming' ? 'providerId' : 'applicationId'
  const to = direction === 'incoming' ? 'applicationId' : 'providerId'
  const match = entries.find((pair) => pair[from] === id)
  if (match) return match[to]
  // Never allow a retired application ID to authenticate through identity
  // fallback, or a mapped provider ID to masquerade as an application ID.
  if (entries.some((pair) => pair[to] === id)) invalid()
  return id // Unmapped new identities retain existing onboarding semantics.
}

export const applicationUserId = (id: string): string => translate('user', id, 'incoming')
export const applicationTenantId = (id: string): string => translate('organization', id, 'incoming')
export const providerUserId = (id: string): string => translate('user', id, 'outgoing')
export const providerOrganizationId = (id: string): string =>
  translate('organization', id, 'outgoing')
