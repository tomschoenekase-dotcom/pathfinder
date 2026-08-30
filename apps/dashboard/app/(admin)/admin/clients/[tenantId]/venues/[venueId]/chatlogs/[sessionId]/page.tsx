export const dynamic = 'force-dynamic'

import Link from 'next/link'

import { AdminChatlogNotableToggle } from '../../../../../../../../../components/admin/AdminChatlogNotableToggle'
import { AdminChatlogNoteForm } from '../../../../../../../../../components/admin/AdminChatlogNoteForm'
import { createAdminCaller } from '../../../../../../../../../lib/admin-caller'

type AdminChatlogDetailPageProps = {
  params: Promise<{ tenantId: string; venueId: string; sessionId: string }>
  searchParams: Promise<{ beforeSequence?: string }>
}

function parseBeforeSequence(value?: string): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

export default async function AdminChatlogDetailPage({
  params,
  searchParams,
}: AdminChatlogDetailPageProps) {
  const { tenantId, venueId, sessionId } = await params
  const query = await searchParams
  const beforeSequence = parseBeforeSequence(query.beforeSequence)
  const caller = await createAdminCaller()
  const session = await caller.admin.getSessionChatlog({
    tenantId,
    venueId,
    sessionId,
    messageLimit: 50,
    beforeSequence,
  })

  return (
    <div className="space-y-8">
      <Link
        href={`/admin/clients/${tenantId}/venues/${venueId}/chatlogs`}
        className="text-sm font-medium text-pf-primary hover:text-pf-accent"
      >
        Back to chatlogs
      </Link>

      <header className="flex flex-col gap-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">
            {session.venue.name} session
          </h1>
          <p className="mt-2 text-sm text-pf-deep/60">
            Started {session.startedAt.toLocaleString()} - last active{' '}
            {session.lastActiveAt.toLocaleString()}
          </p>
          <span className="mt-3 inline-flex rounded-full bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep/70">
            {session.experienceScope === 'SECOND_LAYER' ? 'Employee chat' : 'Guest chat'}
          </span>
          {session.isNotable ? (
            <span className="mt-3 inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
              Notable
            </span>
          ) : null}
        </div>
        <AdminChatlogNotableToggle
          tenantId={tenantId}
          venueId={venueId}
          sessionId={session.id}
          initialIsNotable={session.isNotable}
        />
      </header>

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Transcript</h2>
            <p className="mt-1 text-sm text-pf-deep/60">
              {session.messageCount.toLocaleString()} total messages · showing at most 50 at a time
            </p>
          </div>
          {beforeSequence !== undefined ? (
            <Link
              href={`/admin/clients/${tenantId}/venues/${venueId}/chatlogs/${sessionId}`}
              className="text-sm font-semibold text-pf-primary hover:text-pf-accent"
            >
              Return to newest
            </Link>
          ) : null}
        </div>
        <div className="space-y-3">
          {session.messages.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-pf-light bg-pf-surface p-4 text-sm text-pf-deep/60">
              No messages are available in this page of the transcript.
            </p>
          ) : (
            session.messages.map((message) => (
              <div
                key={message.id}
                className={[
                  'max-w-3xl rounded-2xl px-4 py-3 text-sm leading-6',
                  message.role === 'user'
                    ? 'ml-auto bg-pf-primary text-white'
                    : 'mr-auto border border-pf-light bg-pf-surface text-pf-deep',
                ].join(' ')}
              >
                <p>{message.content}</p>
                <p
                  className={[
                    'mt-2 text-xs',
                    message.role === 'user' ? 'text-white/70' : 'text-pf-deep/40',
                  ].join(' ')}
                >
                  {message.role} - {message.createdAt.toLocaleString()}
                </p>
              </div>
            ))
          )}
        </div>
        {session.nextBeforeSequence !== null ? (
          <Link
            href={`/admin/clients/${tenantId}/venues/${venueId}/chatlogs/${sessionId}?beforeSequence=${session.nextBeforeSequence}`}
            className="inline-flex min-h-10 items-center rounded-full border border-pf-light px-4 text-sm font-semibold text-pf-primary transition hover:border-pf-accent hover:text-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          >
            Older messages
          </Link>
        ) : null}
      </section>

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Answers captured</h2>
        {session.engagementResponses.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light bg-pf-surface px-4 py-4 text-sm text-pf-deep/60">
            No engagement answers captured in this session.
          </p>
        ) : (
          <div className="space-y-3">
            {session.engagementResponses.map((response) => (
              <article
                key={response.id}
                className="rounded-2xl border border-pf-light bg-pf-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-pf-deep">{response.questionText}</p>
                  {response.isAiInvented ? (
                    <span className="rounded-full bg-pf-white px-2 py-0.5 text-xs font-semibold text-pf-deep/50">
                      AI-invented
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-6 text-pf-deep/70">{response.answerText}</p>
                <p className="mt-2 text-xs text-pf-deep/40">
                  Asked {response.askedAt.toLocaleString()} - answered{' '}
                  {response.answeredAt.toLocaleString()}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Admin notes</h2>
        <AdminChatlogNoteForm
          tenantId={tenantId}
          venueId={session.venueId}
          sessionId={session.id}
          initialNotes={session.adminNotes}
        />
      </section>
    </div>
  )
}
