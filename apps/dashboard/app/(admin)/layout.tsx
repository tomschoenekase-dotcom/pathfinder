export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { auth, currentUser } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

import { AdminSectionShell } from '../../components/admin/AdminSectionShell'

type AdminLayoutProps = {
  children: ReactNode
}

// Reads platform_role from Clerk public metadata — the SAME source the
// adminProcedure uses server-side (resolveSession → currentUser). This layout
// gate is UX only; the real authorization boundary is the adminProcedure on
// every admin.* tRPC call.
export default async function AdminLayout({ children }: AdminLayoutProps) {
  const { userId } = await auth()

  if (!userId) {
    redirect('/sign-in')
  }

  const user = await currentUser()
  const platformRole = (user?.publicMetadata as { platform_role?: unknown } | undefined)
    ?.platform_role

  if (platformRole !== 'PLATFORM_ADMIN') {
    redirect('/')
  }

  return <AdminSectionShell>{children}</AdminSectionShell>
}
