import { logger } from '@pathfinder/config/logger'

import { db } from '../client'
import { writeAuditLog } from './audit'

type TenantRole = 'STAFF' | 'MANAGER' | 'OWNER'

// Clerk role → TenantRole mapping.
// org:admin → OWNER (full control)
// org:manager → MANAGER (operational CRUD)
// org:member / any other → STAFF (read-only + limited ops)
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
    email_addresses?: Array<{ email_address: string }>
  }
  role: string
}

type OrgCreatedData = {
  id: string
  name: string
  slug: string
}

export type ClerkWebhookEvent =
  | { type: 'organizationMembership.created'; data: OrgMembershipData }
  | { type: 'organizationMembership.updated'; data: OrgMembershipData }
  | { type: 'organizationMembership.deleted'; data: OrgMembershipData }
  | { type: 'organization.created'; data: OrgCreatedData }

export async function handleClerkEvent(event: ClerkWebhookEvent): Promise<void> {
  switch (event.type) {
    case 'organization.created':
      await syncTenantCreated(event.data)
      break
    case 'organizationMembership.created':
      await syncMembershipCreated(event.data)
      break
    case 'organizationMembership.updated':
      await syncMembershipUpdated(event.data)
      break
    case 'organizationMembership.deleted':
      await syncMembershipDeleted(event.data)
      break
    default:
      // Unknown event type — log and ignore
      logger.info({
        service: '@pathfinder/db',
        action: 'clerk.webhook.unknown_event',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        eventType: (event as any).type,
      })
  }
}

async function syncTenantCreated(data: OrgCreatedData): Promise<void> {
  await db.tenant.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      name: data.name,
      slug: data.slug,
    },
    update: {
      name: data.name,
    },
  })

  logger.info({
    service: '@pathfinder/db',
    action: 'clerk.webhook.tenant_synced',
    tenantId: data.id,
  })
}

export async function syncMembershipCreated(data: OrgMembershipData): Promise<void> {
  const tenantId = data.organization.id
  const userId = data.public_user_data.user_id
  const email = data.public_user_data.email_addresses?.[0]?.email_address ?? ''
  const fullName = [data.public_user_data.first_name, data.public_user_data.last_name]
    .filter(Boolean)
    .join(' ') || null
  const role = mapClerkRoleToTenantRole(data.role)

  // Verify tenant exists — Clerk may send membership.created before organization.created
  const tenant = await db.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) {
    logger.warn({
      service: '@pathfinder/db',
      action: 'clerk.webhook.tenant_not_found',
      tenantId,
      userId,
    })
    return
  }

  // Upsert the user record
  await db.user.upsert({
    where: { id: userId },
    create: { id: userId, email, fullName },
    update: { email, fullName },
  })

  // Upsert the membership (idempotent — handles Clerk retries)
  const membership = await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { tenantId, userId, role, status: 'ACTIVE', joinedAt: new Date() },
    update: { role, status: 'ACTIVE' },
  })

  await writeAuditLog({
    tenantId,
    actorId: userId,
    actorRole: role,
    action: 'member.synced',
    targetType: 'TenantMembership',
    targetId: membership.id,
    afterState: { tenantId, userId, role, status: 'ACTIVE' },
  })
}

export async function syncMembershipUpdated(data: OrgMembershipData): Promise<void> {
  const tenantId = data.organization.id
  const userId = data.public_user_data.user_id
  const role = mapClerkRoleToTenantRole(data.role)

  const existing = await db.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  })

  const membership = await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { tenantId, userId, role, status: 'ACTIVE', joinedAt: new Date() },
    update: { role, status: 'ACTIVE' },
  })

  await writeAuditLog({
    tenantId,
    actorId: userId,
    actorRole: role,
    action: 'member.synced',
    targetType: 'TenantMembership',
    targetId: membership.id,
    ...(existing ? { beforeState: { role: existing.role, status: existing.status } } : {}),
    afterState: { role, status: 'ACTIVE' },
  })
}

export async function syncMembershipDeleted(data: OrgMembershipData): Promise<void> {
  const tenantId = data.organization.id
  const userId = data.public_user_data.user_id
  const role = mapClerkRoleToTenantRole(data.role)

  const existing = await db.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
  })

  if (!existing) {
    logger.warn({
      service: '@pathfinder/db',
      action: 'clerk.webhook.membership_not_found_on_delete',
      tenantId,
      userId,
    })
    return
  }

  // Soft-delete: set status REMOVED, never hard-delete
  const membership = await db.tenantMembership.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { status: 'REMOVED' },
  })

  await writeAuditLog({
    tenantId,
    actorId: userId,
    actorRole: role,
    action: 'member.synced',
    targetType: 'TenantMembership',
    targetId: membership.id,
    beforeState: { role: existing.role, status: existing.status },
    afterState: { role: existing.role, status: 'REMOVED' },
  })
}
