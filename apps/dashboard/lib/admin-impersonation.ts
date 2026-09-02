const ADMIN_IMPERSONATION_TIMEOUT_MS = 10_000

export const ADMIN_IMPERSONATION_ERROR = 'Admin view could not be changed. Please try again.'

export async function setAdminImpersonation(tenantId: string | null): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error(ADMIN_IMPERSONATION_ERROR))
      }, ADMIN_IMPERSONATION_TIMEOUT_MS)
    })
    const response = await Promise.race([
      fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
        signal: controller.signal,
      }),
      deadline,
    ])
    void response.body?.cancel('admin-impersonation-response-consumed').catch(() => undefined)
    if (!response.ok) throw new Error(ADMIN_IMPERSONATION_ERROR)
  } catch {
    throw new Error(ADMIN_IMPERSONATION_ERROR)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
