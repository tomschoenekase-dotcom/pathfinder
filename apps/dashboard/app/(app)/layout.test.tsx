import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cookies: vi.fn(),
  availability: vi.fn(),
  getSettings: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('next/headers', () => ({ cookies: mocks.cookies }))
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Error(`redirect:${location}`)
  },
}))
vi.mock('../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    analytics: { getWeeklyReportAvailability: mocks.availability },
    tenant: { getSettings: mocks.getSettings },
  })),
}))
vi.mock('../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import DashboardAppLayout from './layout'

describe('DashboardAppLayout report availability', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({
      userId: 'user-1',
      orgId: 'tenant-1',
      sessionClaims: {},
    })
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) })
    mocks.availability.mockResolvedValue({ enabledVenueIds: [] })
  })

  it('enables report navigation when at least one authorized venue is enabled', async () => {
    mocks.availability.mockResolvedValueOnce({ enabledVenueIds: ['venue-2'] })

    const result = await DashboardAppLayout({ children: <div>content</div> })

    expect(mocks.availability).toHaveBeenCalledWith()
    expect(result.props.children.props.weeklyReportsAvailable).toBe(true)
  })

  it('uses canonical cache scope and lets an authorized impersonation override the active provider org', async () => {
    const miniature = 'org_3HN2BNDTxN9EU5HrfMOh9gWIxao'
    const space = 'org_3HV2vyn6xVr0wPRx2PAmC6AH7V2'
    vi.stubEnv(
      'CLERK_IDENTITY_BINDING',
      JSON.stringify({
        version: 1,
        issuer: 'https://clerk.synthetic.example',
        instanceId: 'ins_synthetic',
        webhookSecretSha256: 'a'.repeat(64),
        users: [{ providerId: 'user_newTom', applicationId: 'user_oldTom' }],
        organizations: [
          { providerId: 'org_newMiniature', applicationId: miniature },
          { providerId: 'org_newSpace', applicationId: space },
        ],
      }),
    )
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_synthetic')
    const key = `pk_live_${Buffer.from('clerk.synthetic.example$').toString('base64')}`
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', key)
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', key)
    mocks.auth.mockResolvedValue({
      userId: 'user_newTom',
      orgId: 'org_newMiniature',
      sessionClaims: { iss: 'https://clerk.synthetic.example' },
    })
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => ({ value: space })) })
    const ordinary = await DashboardAppLayout({ children: <div>content</div> })
    expect(ordinary.props.scopeKey).toBe(`tenant:${miniature}`)
    expect(mocks.getSettings).not.toHaveBeenCalled()
    mocks.auth.mockResolvedValue({
      userId: 'user_newTom',
      orgId: 'org_newMiniature',
      sessionClaims: {
        iss: 'https://clerk.synthetic.example',
        publicMetadata: { platform_role: 'PLATFORM_ADMIN' },
      },
    })
    mocks.getSettings.mockResolvedValue({ tenant: { name: 'Space' } })
    const impersonated = await DashboardAppLayout({ children: <div>content</div> })
    expect(impersonated.props.scopeKey).toBe(`tenant:${space}`)
    expect(impersonated.props.children.props.impersonatedTenantName).toBe('Space')
  })

  it('keeps report navigation hidden when no venue is enabled or availability fails', async () => {
    const disabled = await DashboardAppLayout({ children: <div>content</div> })
    expect(disabled.props.children.props.weeklyReportsAvailable).toBe(false)

    mocks.availability.mockRejectedValueOnce(new Error('private provider detail'))
    const unavailable = await DashboardAppLayout({ children: <div>content</div> })
    expect(unavailable.props.children.props.weeklyReportsAvailable).toBe(false)
  })
})
