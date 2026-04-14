import React from 'react'

type QuickPromptChipsProps = {
  onSend: (message: string) => void
  venueName?: string | undefined
  venueCategory?: string | undefined
}

export function buildPrompts(venueName?: string, venueCategory?: string): string[] {
  return [
    "What's worth seeing near me right now?",
    'Where should I go next?',
    'Where are the restrooms?',
    "What's good to eat or drink here?",
    venueName ? `What makes ${venueName} special?` : "What's the best part of this venue?",
    venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
      ? 'What animals can I see today?'
      : "What's good to do with kids?",
  ]
}

export function QuickPromptChips({ onSend, venueName, venueCategory }: QuickPromptChipsProps) {
  const prompts = buildPrompts(venueName, venueCategory)

  return (
    <section className="mb-4">
      <div className="mb-3">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cyan-300">
          Start with a question
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-white/10 bg-white/5 px-4 text-center text-sm font-medium text-slate-100 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 sm:justify-start sm:text-left"
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
