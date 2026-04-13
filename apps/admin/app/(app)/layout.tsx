import type { ReactNode } from 'react'
import { auth } from '@clerk/nextjs/server'
import { redirect } from 'next/navigation'

type AppLayoutProps = {
  children: ReactNode
}

export default async function AdminAppLayout({ children }: AppLayoutProps) {
  const { userId, sessionClaims } = await auth()
  const platformRole =
    sessionClaims?.publicMetadata &&
    typeof sessionClaims.publicMetadata === 'object' &&
    'platform_role' in sessionClaims.publicMetadata
      ? sessionClaims.publicMetadata.platform_role
      : undefined

  if (!userId) {
    redirect('/sign-in')
  }

  if (platformRole !== 'PLATFORM_ADMIN') {
    redirect('/sign-in')
  }

  return <>{children}</>
}
