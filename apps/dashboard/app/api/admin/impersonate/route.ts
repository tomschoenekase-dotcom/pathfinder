import { auth } from '@clerk/nextjs/server'
import { logger } from '@pathfinder/config/logger'
import { db, writeAuditLogStrict } from '@pathfinder/db'
import { type NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'pf_admin_tenant'
const COOKIE_MAX_AGE = 60 * 60 * 8

function requestMetadata(req: Request) {
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = req.headers.get('user-agent') ?? undefined
  return {
    ...(forwardedFor ? { ipAddress: forwardedFor } : {}),
    ...(userAgent ? { userAgent } : {}),
  }
}

export async function POST(req: NextRequest) {
  const { userId, sessionClaims } = await auth()

  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })

  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const tenantId = (body as Record<string, unknown>).tenantId
  if (tenantId !== undefined && tenantId !== null && typeof tenantId !== 'string') {
    return NextResponse.json({ error: 'Invalid tenantId' }, { status: 400 })
  }

  const targetTenantId = typeof tenantId === 'string' ? tenantId.trim() : ''
  const previousTenantId = req.cookies.get(COOKIE_NAME)?.value
  if (targetTenantId) {
    const tenant = await db.tenant.findUnique({
      where: { id: targetTenantId },
      select: { id: true },
    })
    if (!tenant) return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
  }

  const action = targetTenantId ? 'admin.impersonation.started' : 'admin.impersonation.stopped'
  const auditTargetId = targetTenantId || previousTenantId
  if (auditTargetId) {
    try {
      await writeAuditLogStrict({
        tenantId: auditTargetId,
        actorId: userId,
        actorRole: 'PLATFORM_ADMIN',
        action,
        targetType: 'Tenant',
        targetId: auditTargetId,
        ...(targetTenantId
          ? { afterState: { impersonatedTenantId: targetTenantId } }
          : { beforeState: { impersonatedTenantId: previousTenantId } }),
        ...requestMetadata(req),
      })
    } catch (error) {
      logger.error({
        action: 'admin.impersonation.audit-failed',
        actorId: userId,
        targetId: auditTargetId,
        error: error instanceof Error ? error.message : 'Unknown audit error',
      })
      return NextResponse.json({ error: 'Audit unavailable' }, { status: 503 })
    }
  }

  const response = NextResponse.json({ ok: true })
  if (!targetTenantId) response.cookies.delete(COOKIE_NAME)
  else {
    response.cookies.set(COOKIE_NAME, targetTenantId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    })
  }
  return response
}
