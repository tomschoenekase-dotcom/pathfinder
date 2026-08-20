import { TorchikoIcon } from '@pathfinder/ui/brand'

export function VenueCharacterFallback({
  compact = false,
  status = 'unavailable',
}: {
  compact?: boolean
  status?: 'loading' | 'unavailable'
}) {
  return (
    <div
      className={`flex items-center justify-center gap-3 rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 ${compact ? 'min-h-16' : 'min-h-24'}`}
      role="status"
    >
      <TorchikoIcon className={compact ? 'h-9 w-9' : 'h-12 w-12'} />
      <p className="text-sm text-[var(--chat-text-muted)]">
        {status === 'loading'
          ? 'Character is getting ready. Text chat is ready now.'
          : 'The character display is unavailable. Text chat is still ready.'}
      </p>
    </div>
  )
}
