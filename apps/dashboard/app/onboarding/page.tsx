'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  CreateOrganization,
  OrganizationList,
  SignOutButton,
  useOrganizationList,
} from '@clerk/nextjs'

export default function DashboardOnboardingPage() {
  const router = useRouter()
  const { isLoaded, userMemberships, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  })

  // If the user belongs to exactly one org, activate it automatically and
  // skip the picker entirely. Clients will always have exactly one org.
  useEffect(() => {
    if (!isLoaded || !userMemberships.data) return

    const memberships = userMemberships.data

    const first = memberships[0]
    if (memberships.length === 1 && setActive && first) {
      void setActive({ organization: first.organization.id }).then(() => {
        router.replace('/')
      })
    }
  }, [isLoaded, userMemberships.data, setActive, router])

  if (!isLoaded || (userMemberships.data && userMemberships.data.length === 1)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-pf-surface">
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-pf-deep/60">Loading your dashboard...</p>
          <SignOutButton>
            <button
              type="button"
              className="text-xs text-pf-deep/30 underline hover:text-pf-primary"
            >
              Sign out
            </button>
          </SignOutButton>
        </div>
      </main>
    )
  }

  // Multi-org users (platform admin) see the picker; new users with no org see create form.
  const hasMemberships = userMemberships.data && userMemberships.data.length > 0

  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface">
      <div className="flex flex-col items-center gap-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-pf-deep">Welcome to PathFinder</h1>
          <p className="mt-2 text-pf-deep/60">
            {hasMemberships
              ? 'Select your organization.'
              : 'Create an organization to get started.'}
          </p>
        </div>
        <div className="rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm">
          {hasMemberships ? (
            <OrganizationList
              hidePersonal
              afterSelectOrganizationUrl="/"
              afterCreateOrganizationUrl="/"
            />
          ) : (
            <CreateOrganization afterCreateOrganizationUrl="/" />
          )}
        </div>
        <SignOutButton>
          <button type="button" className="text-xs text-pf-deep/30 underline hover:text-pf-primary">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </main>
  )
}
