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
    venueName ? `What makes ${venueName} special?` : "What's this venue all about?",
    venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
      ? 'What animals can I see today?'
      : "What's good to do with kids?",
  ]
}

export function QuickPromptChips({ onSend, venueName, venueCategory }: QuickPromptChipsProps) {
  const prompts = buildPrompts(venueName, venueCategory)

  return (
    <section className="mb-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-pf-deep/40">
        Start with a question
      </p>
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="inline-flex min-h-10 items-center justify-center rounded-full border border-pf-light bg-pf-white px-4 text-center text-sm font-medium text-pf-primary shadow-sm transition hover:border-pf-accent hover:bg-pf-accent/5"
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
