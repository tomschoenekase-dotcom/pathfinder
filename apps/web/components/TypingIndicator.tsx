export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-[1.75rem] border border-white/10 bg-white/8 px-4 py-3 shadow-lg">
        <div className="flex items-center gap-2" aria-label="Assistant is typing" role="status">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="h-2 w-2 rounded-full bg-cyan-300 animate-pulse"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
