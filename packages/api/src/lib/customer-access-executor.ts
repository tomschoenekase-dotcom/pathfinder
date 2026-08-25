import { ensureOrganizationInvitation } from '@pathfinder/auth'
import {
  confirmCustomerInvitationAction,
  markCustomerInvitationReconciliationAction,
  startApprovedCustomerInvitationAction,
  type CustomerAccessExecutionActor,
} from '@pathfinder/db'

type ExecutionInput = {
  tenantId: string
  venueId: string
  requestId: string
  expectedUpdatedAt: Date
  actor: CustomerAccessExecutionActor
}

type InvitationProvider = {
  ensure(input: {
    organizationId: string
    emailAddress: string
    role: 'org:member'
    inviterUserId: string
  }): Promise<{ id: string; replayed: boolean }>
}

type ExecutionActions = {
  start: typeof startApprovedCustomerInvitationAction
  confirm: typeof confirmCustomerInvitationAction
  markReconciliation: typeof markCustomerInvitationReconciliationAction
}

export type CustomerAccessExecutorDependencies = {
  provider: InvitationProvider
  actions: ExecutionActions
}

const defaultDependencies: CustomerAccessExecutorDependencies = {
  provider: { ensure: ensureOrganizationInvitation },
  actions: {
    start: startApprovedCustomerInvitationAction,
    confirm: confirmCustomerInvitationAction,
    markReconciliation: markCustomerInvitationReconciliationAction,
  },
}

/**
 * Executes exactly one approved customer invitation. The database commits its
 * provider-start fence before Clerk I/O. Retrying an ambiguous run first records
 * reconciliation state, then uses Clerk's pending-invitation lookup before any
 * possible create. It never writes TenantMembership directly.
 */
export async function executeApprovedCustomerInvitation(
  input: ExecutionInput,
  dependencies: CustomerAccessExecutorDependencies = defaultDependencies,
) {
  let started = await dependencies.actions.start(input)

  if (started.state === 'INVITED') {
    return {
      requestId: started.request.id,
      status: 'INVITED' as const,
      providerInvitationId: started.request.providerInvitationId!,
      replayed: true,
      membershipCreatedLocally: false,
    }
  }

  if (started.state === 'RECONCILIATION_REQUIRED') {
    const reconciled = await dependencies.actions.markReconciliation({
      ...input,
      expectedUpdatedAt: started.request.updatedAt,
      failureClass: 'OUTCOME_AMBIGUOUS',
    })
    started = await dependencies.actions.start({
      ...input,
      expectedUpdatedAt: reconciled.updatedAt,
    })
  }

  if (started.state !== 'CALL_PROVIDER') {
    throw new Error('Customer invitation did not enter a provider-callable state.')
  }

  let providerResult: { id: string; replayed: boolean }
  try {
    providerResult = await dependencies.provider.ensure({
      organizationId: started.request.tenantId,
      emailAddress: started.request.targetEmail,
      role: 'org:member',
      inviterUserId: started.inviterUserId,
    })
  } catch (error) {
    await dependencies.actions.markReconciliation({
      ...input,
      expectedUpdatedAt: started.request.updatedAt,
      failureClass: 'OUTCOME_AMBIGUOUS',
    })
    throw error
  }

  const confirmed = await dependencies.actions.confirm({
    ...input,
    expectedUpdatedAt: started.request.updatedAt,
    providerInvitationId: providerResult.id,
    providerReplayed: providerResult.replayed,
  })

  return {
    requestId: confirmed.id,
    status: 'INVITED' as const,
    providerInvitationId: confirmed.providerInvitationId!,
    replayed: confirmed.replayed || providerResult.replayed,
    membershipCreatedLocally: false,
  }
}
