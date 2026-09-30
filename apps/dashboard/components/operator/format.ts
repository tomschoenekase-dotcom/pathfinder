const when = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
})

/** Fixed to UTC so the server render and the browser agree. */
export function formatWhen(value: Date | null | undefined) {
  return value ? `${when.format(value)} UTC` : 'Never'
}

export function untilLabel(expiresAt: Date, now: Date) {
  const minutes = Math.floor((expiresAt.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return 'expired'
  if (minutes < 60) return `expires in ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `expires in ${hours} h`
  return `expires in ${Math.floor(hours / 24)} days`
}

/** How long ago, for "last used". Coarse on purpose. */
export function agoLabel(value: Date | null, now: Date) {
  if (!value) return 'Never used'
  const minutes = Math.max(0, Math.floor((now.getTime() - value.getTime()) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}
