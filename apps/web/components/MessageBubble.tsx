type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-[1.75rem] px-4 py-3 text-sm leading-6 shadow-lg ${
          isUser
            ? 'bg-cyan-400 text-slate-950'
            : 'border border-white/10 bg-white/8 text-slate-100'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>
    </div>
  )
}
