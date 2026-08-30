import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = typeof db
type HumanActor = { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }

export class ProspectDeliveryControlError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'APPROVAL_REQUIRED',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectDeliveryControlError'
  }
}

/** Disable-only emergency control. Re-enabling delivery remains a separate owner-reviewed action. */
export async function emergencyStopProspectDeliveryAction(
  input: { reason: string; actor: HumanActor },
  client: Client = db,
) {
  if (!input.actor.id || input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectDeliveryControlError(
      'APPROVAL_REQUIRED',
      'A human platform administrator is required',
    )
  }
  const reason = input.reason.trim()
  if (!reason || reason.length > 2_000) {
    throw new ProspectDeliveryControlError(
      'INVALID_INPUT',
      'A bounded emergency-stop reason is required',
    )
  }
  return client.$transaction(async (tx) => {
    const before = await tx.prospectDeliveryControl.findUnique({ where: { id: 'global' } })
    const control = await tx.prospectDeliveryControl.upsert({
      where: { id: 'global' },
      create: {
        id: 'global',
        deliveryEnabled: false,
        internalOnly: true,
        changedBy: input.actor.id,
        changedReason: reason,
      },
      update: {
        deliveryEnabled: false,
        changedBy: input.actor.id,
        changedReason: reason,
      },
    })
    await tx.prospectOutreachCampaign.updateMany({
      where: { status: 'ACTIVE', pausedAt: null },
      data: { pausedAt: new Date(), updatedBy: input.actor.id },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.delivery.emergency-stop',
        targetType: 'ProspectDeliveryControl',
        targetId: 'global',
        beforeState: { deliveryEnabled: before?.deliveryEnabled ?? false },
        afterState: { deliveryEnabled: false, reason },
      },
      tx,
    )
    return control
  })
}
