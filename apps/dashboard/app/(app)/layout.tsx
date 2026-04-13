export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import { DashboardShell } from '../../components/DashboardShell'

type AppLayoutProps = {
  children: ReactNode
}

export default async function DashboardAppLayout({ children }: AppLayoutProps) {
  const { userId, orgId, sessionClaims } = await auth()

  if (!userId) {
    redirect('/sign-in')
  }

  if (!orgId) {
    redirect('/onboarding')
  }

  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as Record<string, unknown> | undefined)?.platform_role === 'PLATFORM_ADMIN'

  return <DashboardShell isPlatformAdmin={isPlatformAdmin}>{children}</DashboardShell>
}
