'use client'

import { useOrganizationList } from '@clerk/nextjs'

type ViewAsClientButtonProps = {
  tenantId: string
  tenantName?: string
  redirectPath?: string
  label?: string
}

export function ViewAsClientButton({
  tenantId,
  tenantName,
  redirectPath = '/',
  label,
}: ViewAsClientButtonProps) {
  const { setActive, isLoaded } = useOrganizationList()

  async function handleViewAs() {
    if (!setActive) return
    await setActive({ organization: tenantId })
    window.location.href = redirectPath
  }

  return (
    <button
      type="button"
      onClick={handleViewAs}
      disabled={!isLoaded}
      className="rounded-2xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:opacity-50"
    >
      {label ?? `View as ${tenantName} →`}
    </button>
  )
}
