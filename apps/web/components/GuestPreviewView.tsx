import type { GuestPreviewData } from '../lib/guest-preview'

/**
 * Read-only rendering of one private preview version. It has no input, sends no messages and
 * stores nothing; it shows the exact guest-visible content that version would serve.
 */
export function GuestPreviewView({ preview }: { preview: GuestPreviewData }) {
  const expires = new Date(preview.version.expiresAt)
  return (
    <div className="min-h-dvh bg-pf-surface">
      <aside
        aria-label="Private preview notice"
        className="border-b border-slate-300 bg-slate-50 px-4 py-3 text-center text-sm text-slate-700"
      >
        Private preview of a {preview.version.kind === 'release' ? 'release' : 'package draft'} (
        {preview.version.status.toLowerCase()}). Not live. Cannot send messages. Link expires{' '}
        <time dateTime={expires.toISOString()}>{expires.toUTCString()}</time>.
      </aside>
      <main className="mx-auto max-w-3xl px-4 py-8" data-preview-version={preview.version.id}>
        <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">{preview.venue.name}</h1>
        {preview.venue.description ? (
          <p className="mt-2 text-sm leading-6 text-pf-deep/75">{preview.venue.description}</p>
        ) : null}
        <section aria-labelledby="preview-places" className="mt-8">
          <h2 id="preview-places" className="text-lg font-semibold text-pf-deep">
            Places ({preview.places.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {preview.places.map((place, index) => (
              <li
                key={`${place.name}-${index}`}
                className="rounded-2xl border border-pf-light bg-white p-4"
              >
                <p className="font-medium text-pf-deep">{place.name}</p>
                <p className="text-xs text-pf-deep/60">
                  {[place.type, place.areaName, place.hours].filter(Boolean).join(' · ')}
                </p>
                {place.shortDescription ? (
                  <p className="mt-1 text-sm text-pf-deep/80">{place.shortDescription}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="preview-knowledge" className="mt-8">
          <h2 id="preview-knowledge" className="text-lg font-semibold text-pf-deep">
            Guide knowledge ({preview.knowledgeEntries.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {preview.knowledgeEntries.map((entry, index) => (
              <li
                key={`${entry.title}-${index}`}
                className="rounded-2xl border border-pf-light bg-white p-4"
              >
                <p className="font-medium text-pf-deep">{entry.title}</p>
                <p className="text-xs text-pf-deep/60">{entry.category}</p>
                <p className="mt-1 whitespace-pre-line text-sm text-pf-deep/80">{entry.content}</p>
              </li>
            ))}
          </ul>
        </section>
        {preview.modules.length > 0 ? (
          <section aria-labelledby="preview-modules" className="mt-8">
            <h2 id="preview-modules" className="text-lg font-semibold text-pf-deep">
              Structured content ({preview.modules.length})
            </h2>
            <ul className="mt-3 space-y-3">
              {preview.modules.map((module, index) => (
                <li
                  key={`${module.title}-${index}`}
                  className="rounded-2xl border border-pf-light bg-white p-4"
                >
                  <p className="font-medium text-pf-deep">{module.title}</p>
                  <p className="text-xs text-pf-deep/60">{module.kind.toLowerCase()}</p>
                  {module.text ? (
                    <p className="mt-1 text-sm text-pf-deep/80">{module.text}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  )
}
