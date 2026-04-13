export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import { DashboardShell } from '../../components/DashboardShell'

type AppLayoutProps = {
  children: ReactNode
}

export default async function DashboardAppLayout({ children }: AppLayoutProps) {
  const { userId, orgId } = await auth()

  if (!userId) {
    redirect('/sign-in')
  }

  if (!orgId) {
    redirect('/onboarding')
  }

  return <DashboardShell>{children}</DashboardShell>
}
