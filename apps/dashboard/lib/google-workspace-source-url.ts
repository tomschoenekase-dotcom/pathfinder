export type GoogleWorkspaceBrowserSource = Readonly<{
  kind: 'Calendar' | 'Drive' | 'Meet'
  url: string
}>

/**
 * Returns only human-openable Google Workspace URLs. API resource locators such as
 * meet.googleapis.com are deliberately rejected because they require service auth
 * and would create a broken or misleading browser action.
 */
export function safeGoogleWorkspaceSourceUrl(
  reference: string | null | undefined,
): GoogleWorkspaceBrowserSource | null {
  if (!reference) return null

  try {
    const parsed = new URL(reference)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hostname !== parsed.hostname.toLowerCase()
    ) {
      return null
    }

    const allowedHosts: Record<string, GoogleWorkspaceBrowserSource['kind']> = {
      'calendar.google.com': 'Calendar',
      'drive.google.com': 'Drive',
      'docs.google.com': 'Drive',
      'meet.google.com': 'Meet',
    }
    const kind = allowedHosts[parsed.hostname]
    return kind ? { kind, url: parsed.toString() } : null
  } catch {
    return null
  }
}
