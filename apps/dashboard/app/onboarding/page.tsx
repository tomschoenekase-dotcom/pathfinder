'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { CreateOrganization, OrganizationList, SignOutButton, useOrganizationList } from '@clerk/nextjs'

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

    if (memberships.length === 1 && setActive) {
      void setActive({ organization: memberships[0].organization.id }).then(() => {
        router.replace('/')
      })
    }
  }, [isLoaded, userMemberships.data, setActive, router])

  if (!isLoaded || (userMemberships.data && userMemberships.data.length === 1)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-gray-500">Loading your dashboard...</p>
          <SignOutButton>
            <button type="button" className="text-xs text-gray-400 underline hover:text-gray-600">
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
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="flex flex-col items-center gap-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900">Welcome to PathFinder</h1>
          <p className="mt-2 text-gray-600">
            {hasMemberships ? 'Select your organization.' : 'Create an organization to get started.'}
          </p>
        </div>
        {hasMemberships ? (
          <OrganizationList
            hidePersonal
            afterSelectOrganizationUrl="/"
            afterCreateOrganizationUrl="/"
          />
        ) : (
          <CreateOrganization afterCreateOrganizationUrl="/" />
        )}
        <SignOutButton>
          <button type="button" className="text-xs text-gray-400 underline hover:text-gray-600">
            Sign out
          </button>
        </SignOutButton>
      </div>
    </main>
  )
}
