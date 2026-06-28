'use client'

import { useOrganizationList } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

type ViewAsClientButtonProps = {
  tenantId: string
  tenantName: string
}

export function ViewAsClientButton({ tenantId, tenantName }: ViewAsClientButtonProps) {
  const { setActive, isLoaded } = useOrganizationList()
  const router = useRouter()

  async function handleViewAs() {
    if (!setActive) return
    await setActive({ organization: tenantId })
    router.push('/')
  }

  return (
    <button
      type="button"
      onClick={handleViewAs}
      disabled={!isLoaded}
      className="rounded-2xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:opacity-50"
    >
      View as {tenantName} →
    </button>
  )
}
