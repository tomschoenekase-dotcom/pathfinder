import { z } from 'zod'

export {
  customerPortalPolicy,
  evaluateBillingAccess,
} from '@pathfinder/contracts/billing-access-policy'
export type {
  BillingAccessDecision,
  BillingAccessPolicyInput,
} from '@pathfinder/contracts/billing-access-policy'
export type BillingAccessState =
  import('@pathfinder/contracts/billing-access-policy').BillingAccessState

export const BillingAccessState = z.enum([
  'PENDING',
  'ACTIVE',
  'GRACE_PERIOD',
  'PAID_THROUGH',
  'SUSPENDED',
  'ENDED',
  'MANUAL_REVIEW',
])
