import React from 'react'

type QuickPromptChipsProps = {
  onSend: (message: string) => void
}

const QUICK_PROMPTS = [
  'What am I near?',
  'What should I do next?',
  'Where is the nearest bathroom?',
] as const

export function QuickPromptChips({ onSend }: QuickPromptChipsProps) {
  return (
    <section className="mb-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">Quick prompts</p>
        <p className="text-xs text-slate-400">Tap one to begin</p>
      </div>
      <div className="flex flex-wrap gap-3">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            className="inline-flex min-h-11 items-center rounded-full border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-100 transition hover:border-cyan-400/40 hover:bg-cyan-400/10"
            type="button"
            onClick={() => {
              onSend(prompt)
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}
