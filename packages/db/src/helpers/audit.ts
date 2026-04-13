import { logger } from '@pathfinder/config/logger'

import { db } from '../client'

export type WriteAuditLogParams = {
  tenantId?: string
  actorId: string
  actorRole: string
  action: string
  targetType: string
  targetId: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  try {
    const data = {
      actorId: params.actorId,
      actorRole: params.actorRole,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
    }

    if (params.tenantId !== undefined) {
      Object.assign(data, { tenantId: params.tenantId })
    }

    if (params.beforeState !== undefined) {
      Object.assign(data, { beforeState: params.beforeState })
    }

    if (params.afterState !== undefined) {
      Object.assign(data, { afterState: params.afterState })
    }

    if (params.ipAddress !== undefined) {
      Object.assign(data, { ipAddress: params.ipAddress })
    }

    if (params.userAgent !== undefined) {
      Object.assign(data, { userAgent: params.userAgent })
    }

    await db.auditLog.create({ data })
  } catch (error) {
    const logFields = {
      service: '@pathfinder/db',
      action: 'audit-log.write-failed',
      actorId: params.actorId,
      targetType: params.targetType,
      targetId: params.targetId,
      error: error instanceof Error ? error.message : 'Unknown audit log write error',
    }

    if (params.tenantId !== undefined) {
      Object.assign(logFields, { tenantId: params.tenantId })
    }

    logger.warn(logFields)
  }
}
