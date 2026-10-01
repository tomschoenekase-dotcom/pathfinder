import type { Prisma } from '@prisma/client'

import type { db } from '../client'

/**
 * One purpose-aware rule for "may this address be emailed?", shared by the operator's check, the
 * draft, stage and release actions, and any future send route. A rule that lives in one place cannot
 * drift: before this existed the operator accepted addresses canonical sending refused, and
 * canonical sending ignored complaints, hard bounces and blocks on another row for the same address.
 *
 * Reasons are listed in the order they are reported. An address is eligible only if none applies.
 */
export type ProspectEligibilityPurpose = 'draft' | 'send'

export type ProspectEligibilityReason =
  | 'no_address'
  | 'archived'
  | 'do_not_contact'
  | 'organization_do_not_contact'
  | 'suppressed'
  | 'unsubscribed'
  | 'complained'
  | 'bounced'
  | 'opted_out'
  | 'prohibited'
  | 'invalid_address'
  | 'not_verified'
  | 'address_blocked_elsewhere'

export type ProspectEligibilityContact = Readonly<{
  normalizedEmail: string | null
  doNotContact: boolean
  emailReadiness: string
  permissionState: string
  suppressedAt: Date | null
  unsubscribedAt: Date | null
  complainedAt: Date | null
  lastHardBounceAt: Date | null
  archivedAt?: Date | null | undefined
}>

export type ProspectEligibilityContext = Readonly<{
  /** The owning organization's pipeline stage, when known. DO_NOT_CONTACT blocks every contact. */
  organizationStage?: string | null | undefined
  /** Another contact row, archived or not, with the same address is blocked. */
  blockedElsewhere?: boolean | undefined
}>

export type ProspectEligibility = Readonly<{
  eligible: boolean
  purpose: ProspectEligibilityPurpose
  reasons: readonly ProspectEligibilityReason[]
}>

export function evaluateProspectContactEligibility(
  contact: ProspectEligibilityContact,
  purpose: ProspectEligibilityPurpose,
  context: ProspectEligibilityContext = {},
): ProspectEligibility {
  const reasons: ProspectEligibilityReason[] = []
  if (!contact.normalizedEmail) reasons.push('no_address')
  if (contact.archivedAt) reasons.push('archived')
  if (contact.doNotContact) reasons.push('do_not_contact')
  if (context.organizationStage === 'DO_NOT_CONTACT') reasons.push('organization_do_not_contact')
  if (contact.suppressedAt) reasons.push('suppressed')
  if (contact.unsubscribedAt) reasons.push('unsubscribed')
  if (contact.complainedAt) reasons.push('complained')
  if (contact.lastHardBounceAt) reasons.push('bounced')
  if (contact.permissionState === 'OPTED_OUT') reasons.push('opted_out')
  if (contact.permissionState === 'PROHIBITED') reasons.push('prohibited')
  if (contact.emailReadiness === 'INVALID') reasons.push('invalid_address')
  // Drafting may start before an address is verified; sending may not.
  if (
    purpose === 'send' &&
    contact.emailReadiness !== 'VALID' &&
    contact.emailReadiness !== 'INVALID'
  ) {
    reasons.push('not_verified')
  }
  if (context.blockedElsewhere) reasons.push('address_blocked_elsewhere')
  return { eligible: reasons.length === 0, purpose, reasons }
}

/** A row that blocks its address on its own. Mirrors `evaluateProspectContactEligibility`. */
const BLOCKING_ROW: Prisma.ProspectContactWhereInput = {
  OR: [
    { doNotContact: true },
    { suppressedAt: { not: null } },
    { unsubscribedAt: { not: null } },
    { complainedAt: { not: null } },
    { lastHardBounceAt: { not: null } },
    { permissionState: { in: ['OPTED_OUT', 'PROHIBITED'] } },
    { emailReadiness: 'INVALID' },
    { organization: { opportunity: { is: { stage: 'DO_NOT_CONTACT' } } } },
  ],
}

type ContactReader = Pick<Parameters<Parameters<typeof db.$transaction>[0]>[0], 'prospectContact'>

/**
 * True when any contact row, archived rows included, other than `exceptContactId`, with the same
 * normalized address is blocked. An existence query rather than a capped scan, so a block on an old
 * alias can never be missed because many other rows came first.
 */
export async function isAddressBlockedOnAnotherRow(
  reader: ContactReader,
  normalizedEmail: string,
  exceptContactId?: string,
): Promise<boolean> {
  const row = await reader.prospectContact.findFirst({
    where: {
      normalizedEmail,
      ...(exceptContactId ? { id: { not: exceptContactId } } : {}),
      ...BLOCKING_ROW,
    },
    select: { id: true },
  })
  return row !== null
}

export const PROSPECT_ELIGIBILITY_REASON_TEXT: Readonly<Record<ProspectEligibilityReason, string>> =
  {
    no_address: 'has no email address',
    archived: 'is archived',
    do_not_contact: 'is marked do not contact',
    organization_do_not_contact: 'belongs to an account marked do not contact',
    suppressed: 'is suppressed',
    unsubscribed: 'unsubscribed',
    complained: 'complained',
    bounced: 'hard bounced',
    opted_out: 'opted out',
    prohibited: 'is prohibited from contact',
    invalid_address: 'has an invalid address',
    not_verified: 'has not been verified for sending',
    address_blocked_elsewhere: 'has the same address blocked on another record',
  }
