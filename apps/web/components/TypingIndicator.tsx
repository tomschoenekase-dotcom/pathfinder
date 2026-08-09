export function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-hidden="true">
      <div className="max-w-[85%] rounded-[1.75rem] border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 py-3">
        <div className="flex items-center gap-2">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 animate-pulse rounded-full bg-[var(--chat-accent)] motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
