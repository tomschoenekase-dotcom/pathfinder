export function safeGmailSourceUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'mail.google.com' ||
      url.port ||
      url.username ||
      url.password ||
      !url.pathname.startsWith('/mail/u/')
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
