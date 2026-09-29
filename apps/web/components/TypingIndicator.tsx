import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// The dots appear at once. A calm status line follows after a short pause, and only a genuinely
// long wait changes it once more. The whole indicator is aria-hidden; screen readers hear the
// single "answering" status owned by ChatWindow, never these visual changes.
const WAITING_STATUS_DELAY_MS = 1_500
const LONG_WAIT_STATUS_DELAY_MS = 12_000

export function TypingIndicator({
  statusLabel,
  longWaitLabel = statusLabel,
}: {
  statusLabel: ReactNode
  longWaitLabel?: ReactNode
}) {
  const [stage, setStage] = useState<'dots' | 'waiting' | 'long'>('dots')

  useEffect(() => {
    const waiting = window.setTimeout(() => setStage('waiting'), WAITING_STATUS_DELAY_MS)
    const long = window.setTimeout(() => setStage('long'), LONG_WAIT_STATUS_DELAY_MS)

    return () => {
      window.clearTimeout(waiting)
      window.clearTimeout(long)
    }
  }, [])

  return (
    <div className="flex justify-start" aria-hidden="true">
      <div className="max-w-[85%] rounded-[1.75rem] border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 py-3">
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-2" data-testid="typing-indicator-dots">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="h-2 w-2 animate-pulse rounded-full bg-[var(--chat-accent)] motion-reduce:animate-none"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </div>
          {stage !== 'dots' ? (
            <p className="text-xs leading-4 text-[var(--chat-text-muted)]">
              {stage === 'long' ? longWaitLabel : statusLabel}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
