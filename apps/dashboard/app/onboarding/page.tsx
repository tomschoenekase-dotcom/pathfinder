'use client'

import { type FormEvent, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { OrganizationList, SignOutButton, useClerk, useOrganizationList } from '@clerk/nextjs'

export default function DashboardOnboardingPage() {
  const router = useRouter()
  const clerk = useClerk()
  const { isLoaded, userMemberships, setActive } = useOrganizationList({
    userMemberships: { infinite: true },
  })
  const [orgName, setOrgName] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!orgName.trim() || !setActive) return

    setIsCreating(true)
    setCreateError(null)

    try {
      const org = await clerk.createOrganization({ name: orgName.trim() })
      await setActive({ organization: org.id })
      router.replace('/')
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setIsCreating(false)
    }
  }

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
            <form className="w-80 max-w-full space-y-5" onSubmit={handleCreate}>
              <div className="space-y-2">
                <label htmlFor="organization-name" className="text-sm font-medium text-pf-deep">
                  Organization name
                </label>
                <input
                  id="organization-name"
                  name="organizationName"
                  type="text"
                  value={orgName}
                  onChange={(event) => setOrgName(event.target.value)}
                  autoFocus
                  className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
                />
                <p className="text-xs text-pf-deep/50">
                  This is typically your company or venue operator name.
                </p>
              </div>
              {createError ? <p className="text-sm text-rose-600">{createError}</p> : null}
              <button
                type="submit"
                disabled={isCreating || !orgName.trim()}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  'Get started →'
                )}
              </button>
            </form>
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
