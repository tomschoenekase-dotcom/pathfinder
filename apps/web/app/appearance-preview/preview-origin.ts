// Dependency-free so the edge middleware can import it without the preview's validators.
/**
 * The one client-portal origin allowed to frame and drive the preview. It comes from the
 * web service's own `DASHBOARD_URL`, never from the request. Development falls back to the
 * local dashboard dev server.
 */
export function appearancePreviewParentOrigin(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const development = environment.NODE_ENV === 'development'
  const configured =
    environment.DASHBOARD_URL?.trim() || (development ? 'http://localhost:3001' : '')
  if (!configured) return null
  try {
    const url = new URL(configured)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password) return null
    if (url.protocol === 'https:') return url.origin
    if (url.protocol === 'http:' && loopback && development) return url.origin
    return null
  } catch {
    return null
  }
}
