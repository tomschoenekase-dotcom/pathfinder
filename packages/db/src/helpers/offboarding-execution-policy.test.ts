import { describe, expect, it } from 'vitest'

import {
  billingBlocksOffboarding,
  evaluateOffboardingGate,
  isEffectStep,
  isStepPlanned,
  OFFBOARDING_EXECUTION_STEP_KEYS,
  offboardingDerivedUuid,
  offboardingManifestHash,
  plannedTargetsForStep,
} from './offboarding-execution-policy'

const noBilling = { accountStatus: null, accountBillingMode: null, agreements: [] }
const base = {
  planStatus: 'REVIEWED',
  planVenueIds: ['venue_a', 'venue_b'],
  tenantVenueIds: ['venue_a', 'venue_b'],
  executionStatus: null,
  billing: noBilling,
  billingHandled: false,
} as const

describe('offboarding execution steps', () => {
  it('runs the effect steps first and the recording steps last, each once', () => {
    expect([...OFFBOARDING_EXECUTION_STEP_KEYS]).toEqual([
      'PUBLIC_ACCESS',
      'SCHEDULED_WORK',
      'CONNECTIONS',
      'MEMBER_ACCESS',
      'BILLING',
      'IDENTITY_PROVIDER',
      'DATA_MANIFEST',
    ])
  })

  it('runs an effect step only when the plan asked for one of its targets', () => {
    expect(isStepPlanned('PUBLIC_ACCESS', ['GUEST_LINKS'])).toBe(true)
    expect(isStepPlanned('PUBLIC_ACCESS', ['CLIENT_ACCESS'])).toBe(false)
    expect(isStepPlanned('CONNECTIONS', ['AGENT_IDENTITIES'])).toBe(true)
    expect(isStepPlanned('SCHEDULED_WORK', ['BACKGROUND_JOBS'])).toBe(true)
    expect(isStepPlanned('MEMBER_ACCESS', ['OPERATOR_IMPERSONATION'])).toBe(false)
  })

  it('always runs the three recording steps and never revokes platform impersonation', () => {
    for (const key of ['BILLING', 'IDENTITY_PROVIDER', 'DATA_MANIFEST'] as const) {
      expect(isEffectStep(key)).toBe(false)
      expect(isStepPlanned(key, [])).toBe(true)
    }
    for (const key of OFFBOARDING_EXECUTION_STEP_KEYS) {
      expect(plannedTargetsForStep(key, ['OPERATOR_IMPERSONATION'])).toEqual([])
    }
  })

  it('narrows a step to the targets the plan selected', () => {
    expect(plannedTargetsForStep('PUBLIC_ACCESS', ['GUEST_LINKS', 'CLIENT_ACCESS'])).toEqual([
      'GUEST_LINKS',
    ])
  })
})

describe('billing gate', () => {
  it('does not block when there is no paid arrangement', () => {
    expect(billingBlocksOffboarding(noBilling).blocks).toBe(false)
    expect(
      billingBlocksOffboarding({
        accountStatus: 'ACTIVE',
        accountBillingMode: 'COMPLIMENTARY',
        agreements: [{ status: 'ACTIVE', billingMode: 'PILOT', hasProviderSubscription: false }],
      }).blocks,
    ).toBe(false)
    expect(
      billingBlocksOffboarding({
        accountStatus: 'CANCELED',
        accountBillingMode: 'STRIPE_SUBSCRIPTION',
        agreements: [
          { status: 'ENDED', billingMode: 'STRIPE_SUBSCRIPTION', hasProviderSubscription: true },
        ],
      }).blocks,
    ).toBe(false)
  })

  it.each(['ACTIVE', 'PAST_DUE', 'UNPAID', 'PAUSED', 'TRIALING', 'MANUAL_REVIEW'])(
    'blocks a paid account in %s',
    (status) => {
      expect(
        billingBlocksOffboarding({
          accountStatus: status,
          accountBillingMode: 'STRIPE_SUBSCRIPTION',
          agreements: [],
        }).blocks,
      ).toBe(true)
    },
  )

  it('blocks a live provider subscription whatever mode is recorded', () => {
    expect(
      billingBlocksOffboarding({
        accountStatus: null,
        accountBillingMode: null,
        agreements: [{ status: 'ACTIVE', billingMode: 'PILOT', hasProviderSubscription: true }],
      }).blocks,
    ).toBe(true)
  })
})

describe('offboarding gate', () => {
  it('lets a reviewed or export-ready plan that covers every venue run', () => {
    expect(evaluateOffboardingGate(base)).toEqual({ ok: true })
    expect(evaluateOffboardingGate({ ...base, planStatus: 'EXPORT_READY' })).toEqual({ ok: true })
  })

  it.each(['REQUESTED', 'CANCELLED', 'COMPLETED'])('refuses a plan in %s', (planStatus) => {
    expect(evaluateOffboardingGate({ ...base, planStatus })).toMatchObject({
      ok: false,
      code: 'PLAN_NOT_APPROVED',
    })
  })

  it('refuses a plan that leaves a venue out', () => {
    expect(
      evaluateOffboardingGate({ ...base, tenantVenueIds: ['venue_a', 'venue_b', 'venue_c'] }),
    ).toMatchObject({ ok: false, code: 'PLAN_SCOPE_INCOMPLETE' })
  })

  it('refuses a plan whose earlier execution was reinstated', () => {
    expect(evaluateOffboardingGate({ ...base, executionStatus: 'REINSTATED' })).toMatchObject({
      ok: false,
      code: 'EXECUTION_CLOSED',
    })
    expect(evaluateOffboardingGate({ ...base, executionStatus: 'IN_PROGRESS' })).toEqual({
      ok: true,
    })
  })

  it('refuses a live paid arrangement unless a person said billing is handled', () => {
    const billing = {
      accountStatus: 'ACTIVE',
      accountBillingMode: 'STRIPE_SUBSCRIPTION',
      agreements: [],
    }
    expect(evaluateOffboardingGate({ ...base, billing })).toMatchObject({
      ok: false,
      code: 'BILLING_ACTIVE',
    })
    expect(evaluateOffboardingGate({ ...base, billing, billingHandled: true })).toEqual({
      ok: true,
    })
  })
})

describe('deterministic identities', () => {
  it('derives the same uuid for the same effect and different ones otherwise', () => {
    const first = offboardingDerivedUuid('exec:credential:one')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(offboardingDerivedUuid('exec:credential:one')).toBe(first)
    expect(offboardingDerivedUuid('exec:credential:two')).not.toBe(first)
  })

  it('hashes a manifest independent of key order', () => {
    expect(offboardingManifestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      offboardingManifestHash({ b: { d: 3, c: 2 }, a: 1 }),
    )
    expect(offboardingManifestHash({ a: 1 })).not.toBe(offboardingManifestHash({ a: 2 }))
  })
})
