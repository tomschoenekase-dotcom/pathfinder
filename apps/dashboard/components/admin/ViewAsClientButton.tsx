'use client'

type ViewAsClientButtonProps = {
  tenantId: string
  tenantName?: string
  label?: string
}

export function ViewAsClientButton({ tenantId, tenantName, label }: ViewAsClientButtonProps) {
  async function handleViewAs() {
    await fetch('/api/admin/impersonate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    })
    window.location.href = '/'
  }

  return (
    <button
      type="button"
      onClick={handleViewAs}
      className="rounded-2xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-pf-accent"
    >
      {label ?? `View as ${tenantName ?? 'client'} ->`}
    </button>
  )
}
