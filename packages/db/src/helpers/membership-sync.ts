import { logger } from '@pathfinder/config/logger'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type TenantRole = 'STAFF' | 'MANAGER' | 'OWNER'

// Prisma's extended transaction client is structurally incompatible with the
// generated TransactionClient type under exact optional properties.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MembershipTransaction = any

export const CLERK_WEBHOOK_TRANSACTION_MAX_ATTEMPTS = 3
export const CLERK_WEBHOOK_PROVIDER_EVENT_ID_MAX_LENGTH = 255
export const CLERK_WEBHOOK_EVENT_TYPE_MAX_LENGTH = 100

const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/

class ClerkWebhookReceiptClaimRaceError extends Error {
  constructor() {
    super('Verified Clerk webhook receipt claim was not visible yet.')
    this.name = 'ClerkWebhookReceiptClaimRaceError'
  }
}

export class ClerkWebhookReceiptConflictError extends Error {
  constructor() {
    super('Verified Clerk webhook identity conflicts with an existing receipt.')
    this.name = 'ClerkWebhookReceiptConflictError'
  }
}

export function isClerkWebhookReceiptConflictError(
  error: unknown,
): error is ClerkWebhookReceiptConflictError {
  return error instanceof ClerkWebhookReceiptConflictError
}

export type VerifiedClerkEventIdentity = {
  providerEventId: string
  payloadHash: string
}

// Clerk role → TenantRole mapping.
export function mapClerkRoleToTenantRole(clerkRole: string): TenantRole {
  if (clerkRole === 'org:admin' || clerkRole === 'org:owner') return 'OWNER'
  if (clerkRole === 'org:manager') return 'MANAGER'
  return 'STAFF'
}

type OrgMembershipData = {
  organization: { id: string; name?: string; slug?: string }
  public_user_data: {
    user_id: string
    first_name: string | null
    last_name: string | null
    image_url?: string
    identifier?: string
    email_addresses?: Array<{ email_address: string }>
  }
  role: string
}

type OrgCreatedData = { id: string; name: string; slug: string }

export type ClerkWebhookEvent =
  | { type: 'organizationMembership.created'; data: OrgMembershipData; timestamp: number }
  | { type: 'organizationMembership.updated'; data: OrgMembershipData; timestamp: number }
  | { type: 'organizationMembership.deleted'; data: OrgMembershipData; timestamp: number }
  | { type: 'organization.created'; data: OrgCreatedData; timestamp: number }

export type ClerkWebhookProcessingResult = {
  replayed: boolean
  welcomeEmailDeliveryId: string | null
}

export function getClerkMembershipEmail(
  publicUserData: OrgMembershipData['public_user_data'],
): string | undefined {
  const structuredEmail = publicUserData.email_addresses?.[0]?.email_address.trim()
  if (structuredEmail) return structuredEmail

  const identifier = publicUserData.identifier?.trim()
  return identifier && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identifier) ? identifier : undefined
}

function validateVerifiedIdentity(
  event: ClerkWebhookEvent,
  identity: VerifiedClerkEventIdentity,
): void {
  if (
    typeof identity.providerEventId !== 'string' ||
    identity.providerEventId.trim().length === 0 ||
    identity.providerEventId.length > CLERK_WEBHOOK_PROVIDER_EVENT_ID_MAX_LENGTH
  ) {
    throw new Error('Verified Clerk provider event ID is invalid.')
  }
  if (
    typeof event.type !== 'string' ||
    event.type.length === 0 ||
    event.type.length > CLERK_WEBHOOK_EVENT_TYPE_MAX_LENGTH
  ) {
    throw new Error('Verified Clerk event type is invalid.')
  }
  if (!PAYLOAD_HASH_PATTERN.test(identity.payloadHash)) {
    throw new Error('Verified Clerk payload hash must be lowercase SHA-256 hex.')
  }
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) {
    throw new Error('Verified Clerk event timestamp must be a nonnegative safe integer.')
  }
}

function isRetryableTransactionConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ['P2002', 'P2034'].includes(String((error as { code?: unknown }).code))
  )
}

export async function handleClerkEvent(
  event: ClerkWebhookEvent,
  identity: VerifiedClerkEventIdentity,
): Promise<ClerkWebhookProcessingResult> {
  validateVerifiedIdentity(event, identity)

  for (let attempt = 1; attempt <= CLERK_WEBHOOK_TRANSACTION_MAX_ATTEMPTS; attempt++) {
    try {
      return await db.$transaction(
        async (transaction) => {
          const claim = await transaction.clerkWebhookReceipt.createMany({
            data: {
              providerEventId: identity.providerEventId,
              eventType: event.type,
              payloadHash: identity.payloadHash,
            },
            skipDuplicates: true,
          })

          if (claim.count === 0) {
            const existing = await transaction.clerkWebhookReceipt.findUnique({
              where: { providerEventId: identity.providerEventId },
              select: {
                eventType: true,
                payloadHash: true,
                welcomeEmailMembershipId: true,
              },
            })
            if (!existing) {
              throw new ClerkWebhookReceiptClaimRaceError()
            }
            if (
              existing.eventType !== event.type ||
              existing.payloadHash !== identity.payloadHash
            ) {
              throw new ClerkWebhookReceiptConflictError()
            }
            return {
              replayed: true,
              welcomeEmailDeliveryId: existing.welcomeEmailMembershipId,
            }
          }

          const processed = await processClerkEvent(transaction, event)
          if (processed.welcomeEmailDeliveryId) {
            await transaction.clerkWebhookReceipt.update({
              where: { providerEventId: identity.providerEventId },
              data: { welcomeEmailMembershipId: processed.welcomeEmailDeliveryId },
            })
          }
          return { replayed: false, ...processed }
        },
        { isolationLevel: 'Serializable' },
      )
    } catch (error) {
      if (
        (isRetryableTransactionConflict(error) ||
          error instanceof ClerkWebhookReceiptClaimRaceError) &&
        attempt < CLERK_WEBHOOK_TRANSACTION_MAX_ATTEMPTS
      ) {
        continue
      }
      throw error
    }
  }

  throw new Error('Verified Clerk webhook transaction retry limit exhausted.')
}

async function processClerkEvent(
  transaction: MembershipTransaction,
  event: ClerkWebhookEvent,
): Promise<{ welcomeEmailDeliveryId: string | null }> {
  switch (event.type) {
    case 'organization.created':
      await syncTenantCreated(transaction, event.data)
      return { welcomeEmailDeliveryId: null }
    case 'organizationMembership.created': {
      const result = await syncMembershipActive(transaction, event.data, event.timestamp)
      const shouldWelcome =
        result.created &&
        event.data.role === 'org:admin' &&
        Boolean(event.data.public_user_data.email_addresses?.[0]?.email_address)
      return { welcomeEmailDeliveryId: shouldWelcome ? result.membershipId : null }
    }
    case 'organizationMembership.updated':
      await syncMembershipActive(transaction, event.data, event.timestamp)
      return { welcomeEmailDeliveryId: null }
    case 'organizationMembership.deleted':
      await syncMembershipDeleted(transaction, event.data, event.timestamp)
      return { welcomeEmailDeliveryId: null }
    default:
      logger.info({
        service: '@pathfinder/db',
        action: 'clerk.webhook.unknown_event',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventType: (event as any).type,
      })
      return { welcomeEmailDeliveryId: null }
  }
}

async function syncTenantCreated(
  transaction: MembershipTransaction,
  data: OrgCreatedData,
): Promise<void> {
  await transaction.tenant.upsert({
    where: { id: data.id },
    create: { id: data.id, name: data.name, slug: data.slug },
    update: { name: data.name },
  })
  logger.info({
    service: '@pathfinder/db',
    action: 'clerk.webhook.tenant_synced',
    tenantId: data.id,
  })
}

async function syncMembershipActive(
  transaction: MembershipTransaction,
  data: OrgMembershipData,
  eventTimestamp: number,
): Promise<{ membershipId: string; created: boolean }> {
  const tenantId = data.organization.id
  const userId = data.public_user_data.user_id
  const incomingRole = mapClerkRoleToTenantRole(data.role)
  const cursor = BigInt(eventTimestamp)

  await requireTenant(transaction, tenantId)
  const existing = await transaction.tenantMembership.findUnique({
    where: { tenantId, tenantId_userId: { tenantId, userId } },
  })

  if (existing?.clerkEventTimestamp === null) {
    throwMissingMembershipCursor(tenantId)
  }
  if (existing && activeEventIsStale(existing, cursor, incomingRole)) {
    return { membershipId: existing.id, created: false }
  }

  await upsertClerkUser(transaction, data)
  const role = resolveActiveRole(existing, cursor, incomingRole)
  const nextCursor =
    existing && cursor <= existing.clerkEventTimestamp ? existing.clerkEventTimestamp : cursor
  const nextIsCutoverBaseline = Boolean(
    existing?.clerkCursorIsCutoverBaseline && cursor <= existing.clerkEventTimestamp,
  )
  const membership = existing
    ? await transaction.tenantMembership.update({
        where: { tenantId, tenantId_userId: { tenantId, userId } },
        data: {
          role,
          status: 'ACTIVE',
          clerkEventTimestamp: nextCursor,
          clerkCursorIsCutoverBaseline: nextIsCutoverBaseline,
        },
      })
    : await transaction.tenantMembership.create({
        data: {
          tenantId,
          userId,
          role,
          status: 'ACTIVE',
          joinedAt: new Date(),
          clerkEventTimestamp: cursor,
          clerkCursorIsCutoverBaseline: false,
        },
      })

  if (membershipChanged(existing, role)) {
    await writeAuditLogStrict(
      {
        tenantId,
        actorId: userId,
        actorRole: role,
        action: 'member.synced',
        targetType: 'TenantMembership',
        targetId: membership.id,
        ...(existing ? { beforeState: { role: existing.role, status: existing.status } } : {}),
        afterState: { tenantId, userId, role, status: 'ACTIVE' },
      },
      transaction,
    )
  }
  return { membershipId: membership.id, created: !existing }
}

const ROLE_RANK: Record<TenantRole, number> = { STAFF: 0, MANAGER: 1, OWNER: 2 }

function activeEventIsStale(
  existing: {
    role: string
    status: string
    clerkEventTimestamp: bigint
    clerkCursorIsCutoverBaseline: boolean
  },
  incomingTimestamp: bigint,
  incomingRole: TenantRole,
): boolean {
  if (incomingTimestamp < existing.clerkEventTimestamp) {
    if (!existing.clerkCursorIsCutoverBaseline || existing.status === 'REMOVED') return true
    const existingRole = existing.role as TenantRole
    return ROLE_RANK[incomingRole] >= ROLE_RANK[existingRole]
  }
  if (incomingTimestamp > existing.clerkEventTimestamp) return false
  if (existing.status === 'REMOVED') return true
  const existingRole = existing.role as TenantRole
  return ROLE_RANK[incomingRole] >= ROLE_RANK[existingRole]
}

function resolveActiveRole(
  existing: { role: string; clerkEventTimestamp: bigint } | null,
  incomingTimestamp: bigint,
  incomingRole: TenantRole,
): TenantRole {
  if (!existing || existing.clerkEventTimestamp !== incomingTimestamp) return incomingRole
  const existingRole = existing.role as TenantRole
  return ROLE_RANK[incomingRole] < ROLE_RANK[existingRole] ? incomingRole : existingRole
}

function membershipChanged(
  existing: { role: string; status: string } | null,
  role: TenantRole,
): boolean {
  return !existing || existing.role !== role || existing.status !== 'ACTIVE'
}

async function requireTenant(transaction: MembershipTransaction, tenantId: string): Promise<void> {
  const tenant = await transaction.tenant.findUnique({ where: { id: tenantId } })
  if (tenant) return
  logger.warn({
    service: '@pathfinder/db',
    action: 'clerk.webhook.tenant_not_found',
    tenantId,
  })
  throw new Error('Clerk webhook dependency is not ready')
}

async function upsertClerkUser(
  transaction: MembershipTransaction,
  data: OrgMembershipData,
): Promise<void> {
  const userId = data.public_user_data.user_id
  const email = getClerkMembershipEmail(data.public_user_data)
  const fullName =
    [data.public_user_data.first_name, data.public_user_data.last_name].filter(Boolean).join(' ') ||
    null

  if (email) {
    await transaction.user.upsert({
      where: { id: userId },
      create: { id: userId, email, fullName },
      update: { email, fullName },
    })
    return
  }

  const existing = await transaction.user.findUnique({
    where: { id: userId },
    select: { id: true },
  })
  if (!existing) {
    logger.warn({
      service: '@pathfinder/db',
      action: 'clerk.webhook.user_email_missing',
      tenantId: data.organization.id,
    })
    throw new Error('Clerk webhook user dependency is not ready')
  }
  await transaction.user.update({ where: { id: userId }, data: { fullName } })
}

async function syncMembershipDeleted(
  transaction: MembershipTransaction,
  data: OrgMembershipData,
  eventTimestamp: number,
): Promise<void> {
  const tenantId = data.organization.id
  const userId = data.public_user_data.user_id
  const role = mapClerkRoleToTenantRole(data.role)
  const cursor = BigInt(eventTimestamp)
  const existing = await transaction.tenantMembership.findUnique({
    where: { tenantId, tenantId_userId: { tenantId, userId } },
  })
  if (!existing) {
    logger.warn({
      service: '@pathfinder/db',
      action: 'clerk.webhook.membership_not_found_on_delete',
      tenantId,
    })
    throw new Error('Clerk webhook membership dependency is not ready')
  }
  if (existing.clerkEventTimestamp === null) {
    throwMissingMembershipCursor(tenantId)
  }
  if (cursor < existing.clerkEventTimestamp && !existing.clerkCursorIsCutoverBaseline) return
  const nextCursor = cursor <= existing.clerkEventTimestamp ? existing.clerkEventTimestamp : cursor
  const nextIsCutoverBaseline =
    existing.clerkCursorIsCutoverBaseline && cursor <= existing.clerkEventTimestamp
  if (existing.status === 'REMOVED') {
    if (
      cursor > existing.clerkEventTimestamp ||
      existing.welcomeEmailDeliveredAt === null ||
      existing.clerkCursorIsCutoverBaseline !== nextIsCutoverBaseline
    ) {
      await transaction.tenantMembership.update({
        where: { tenantId, tenantId_userId: { tenantId, userId } },
        data: {
          clerkEventTimestamp: nextCursor,
          clerkCursorIsCutoverBaseline: nextIsCutoverBaseline,
          welcomeEmailDeliveredAt: existing.welcomeEmailDeliveredAt ?? new Date(),
        },
      })
    }
    return
  }

  const membership = await transaction.tenantMembership.update({
    where: { tenantId, tenantId_userId: { tenantId, userId } },
    data: {
      status: 'REMOVED',
      clerkEventTimestamp: nextCursor,
      clerkCursorIsCutoverBaseline: nextIsCutoverBaseline,
      welcomeEmailDeliveredAt: existing.welcomeEmailDeliveredAt ?? new Date(),
    },
  })
  await writeAuditLogStrict(
    {
      tenantId,
      actorId: userId,
      actorRole: role,
      action: 'member.synced',
      targetType: 'TenantMembership',
      targetId: membership.id,
      beforeState: { role: existing.role, status: existing.status },
      afterState: { role: existing.role, status: 'REMOVED' },
    },
    transaction,
  )
}

function throwMissingMembershipCursor(tenantId: string): never {
  logger.warn({
    service: '@pathfinder/db',
    action: 'clerk.webhook.membership_cursor_missing',
    tenantId,
  })
  throw new Error('Clerk webhook membership cursor dependency is not ready')
}

export type WelcomeEmailDeliveryState = {
  complete: boolean
  attemptedAt: Date | null
}

export async function getWelcomeEmailDeliveryState(
  tenantId: string,
  membershipId: string,
): Promise<WelcomeEmailDeliveryState> {
  const membership = await db.tenantMembership.findFirst({
    where: { id: membershipId, tenantId },
    select: {
      status: true,
      welcomeEmailAttemptedAt: true,
      welcomeEmailDeliveredAt: true,
    },
  })
  if (!membership) throw new Error('Welcome email membership dependency is not ready')
  return {
    complete: membership.status !== 'ACTIVE' || membership.welcomeEmailDeliveredAt !== null,
    attemptedAt: membership.welcomeEmailAttemptedAt,
  }
}

export async function beginWelcomeEmailDeliveryAttempt(
  tenantId: string,
  membershipId: string,
): Promise<WelcomeEmailDeliveryState> {
  const attemptedAt = new Date()
  const result = await db.tenantMembership.updateMany({
    where: {
      id: membershipId,
      tenantId,
      status: 'ACTIVE',
      welcomeEmailAttemptedAt: null,
      welcomeEmailDeliveredAt: null,
    },
    data: { welcomeEmailAttemptedAt: attemptedAt },
  })
  if (result.count > 0) return { complete: false, attemptedAt }
  return getWelcomeEmailDeliveryState(tenantId, membershipId)
}

export async function markWelcomeEmailDeliveryComplete(
  tenantId: string,
  membershipId: string,
): Promise<void> {
  const result = await db.tenantMembership.updateMany({
    where: { id: membershipId, tenantId, welcomeEmailDeliveredAt: null },
    data: { welcomeEmailDeliveredAt: new Date() },
  })
  if (result.count > 0) return

  const existing = await db.tenantMembership.findFirst({
    where: { id: membershipId, tenantId },
    select: { welcomeEmailDeliveredAt: true },
  })
  if (!existing?.welcomeEmailDeliveredAt) {
    throw new Error('Welcome email delivery completion could not be persisted')
  }
}
