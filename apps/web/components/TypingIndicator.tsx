import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

const WAITING_STATUS_DELAY_MS = 1_500

export function TypingIndicator({ statusLabel }: { statusLabel: ReactNode }) {
  const [showWaitingStatus, setShowWaitingStatus] = useState(false)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setShowWaitingStatus(true), WAITING_STATUS_DELAY_MS)

    return () => window.clearTimeout(timeoutId)
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
          {showWaitingStatus ? (
            <p className="text-xs leading-4 text-[var(--chat-text-muted)]">{statusLabel}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
