type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
  bubbleColor?: string
  bubbleTextColor?: string
}

export function MessageBubble({ role, content, bubbleColor, bubbleTextColor }: MessageBubbleProps) {
  const isUser = role === 'user'
  const speaker = isUser ? 'You' : 'PathFinder guide'

  return (
    <article className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-[1.75rem] px-4 py-3 text-sm leading-6 ${
          isUser
            ? 'rounded-br-md bg-[var(--chat-accent)] text-[var(--chat-accent-contrast)]'
            : 'rounded-bl-md border border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-text)]'
        }`}
        style={{
          backgroundColor: isUser ? bubbleColor : undefined,
          color: isUser ? bubbleTextColor : undefined,
        }}
      >
        <span className="sr-only" lang="en" dir="ltr">
          {speaker}:
        </span>
        <p className="whitespace-pre-wrap break-words" lang="" dir="auto">
          {content}
        </p>
      </div>
    </article>
  )
}
