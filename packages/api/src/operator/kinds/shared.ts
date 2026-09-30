import type { VenueHumanActor } from '@pathfinder/db'

import type { OperatorHumanActor } from '../proposals'

/**
 * The venue actions accept a tenant OWNER or MANAGER, not a platform admin. The approving human is
 * still the actor id, so the AuditLog names the right person; only the role label is adapted here.
 * The operator's own audit trail records the real role (PLATFORM_ADMIN) and the proposal.
 */
export function venueActor(actor: OperatorHumanActor, role: 'OWNER' | 'MANAGER'): VenueHumanActor {
  return { type: 'HUMAN', id: actor.id, role }
}

/** Marks operator-originated work in canonical audit reasons. */
export function operatorReason(proposalId: string): string {
  return `Applied from operator proposal ${proposalId}`
}
