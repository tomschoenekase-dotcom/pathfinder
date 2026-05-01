type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
  bubbleColor?: string
}

export function MessageBubble({ role, content, bubbleColor }: MessageBubbleProps) {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-[1.75rem] px-4 py-3 text-sm leading-6 ${
          isUser
            ? 'rounded-br-md bg-pf-primary text-white'
            : 'rounded-bl-md border border-pf-light bg-pf-surface text-pf-deep'
        }`}
        style={{ backgroundColor: isUser ? bubbleColor : undefined }}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>
    </div>
  )
}
