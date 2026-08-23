import { ExternalLink, MessageSquareText } from 'lucide-react'

import { safeGmailSourceUrl } from '../../lib/gmail-source-url'

type ProspectCorrespondenceMessage = {
  id: string
  direction: string
  status: string
  fromAddress: string
  toAddresses: string[]
  bodyPreview: string | null
  sourceReference: string | null
  occurredAt: Date | string
}

type ProspectCorrespondenceThread = {
  id: string
  subject: string | null
  messages: ProspectCorrespondenceMessage[]
}

export function ProspectCorrespondenceHistory({
  threads,
}: {
  threads: ProspectCorrespondenceThread[]
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <MessageSquareText className="h-5 w-5 text-sky-700" aria-hidden="true" />
        <h2 className="font-semibold text-slate-950">Correspondence history</h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Gmail remains the canonical source for complete message content. Torchiko shows a compact
        operational preview and links back to the original when available.
      </p>
      {!threads.length ? (
        <p className="mt-4 text-sm text-slate-500">No email correspondence recorded yet.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {threads.map((thread) => (
            <article key={thread.id} className="rounded-xl border border-slate-200">
              <div className="border-b border-slate-100 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  {thread.subject ?? 'Email thread'}
                </h3>
                <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {thread.messages.length} message{thread.messages.length === 1 ? '' : 's'}
                </p>
              </div>
              <ol className="divide-y divide-slate-100">
                {thread.messages.map((message) => {
                  const sourceUrl = safeGmailSourceUrl(message.sourceReference)
                  return (
                    <li key={message.id} className="p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold ${message.direction === 'INBOUND' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}
                        >
                          {message.direction} · {message.status}
                        </span>
                        <time className="text-xs text-slate-400">
                          {new Date(message.occurredAt).toLocaleString()}
                        </time>
                      </div>
                      <p className="mt-2 break-words text-xs font-semibold text-slate-700">
                        {message.direction === 'INBOUND'
                          ? message.fromAddress
                          : `To ${message.toAddresses.join(', ')}`}
                      </p>
                      <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">
                        {message.bodyPreview ?? 'No compact preview is available.'}
                      </p>
                      {sourceUrl ? (
                        <a
                          href={sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-sky-800 hover:border-sky-400 hover:bg-sky-50"
                        >
                          <span className="break-words">Open source email in Gmail</span>
                          <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                        </a>
                      ) : (
                        <p className="mt-3 text-xs text-slate-500">
                          Original source link unavailable.
                        </p>
                      )}
                    </li>
                  )
                })}
              </ol>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
