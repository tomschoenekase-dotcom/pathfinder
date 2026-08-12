'use client'

import Link from 'next/link'
import { type FormEvent, useRef, useState } from 'react'
import { ArrowLeft, Clock3, MapPin, MessageCircle, ShieldCheck, Sparkles } from 'lucide-react'

import type { ClientVenuePackagePreview as Preview } from '@pathfinder/contracts'
import { useTRPCClient } from '../lib/trpc'

type Props = { preview: Preview }

export function ClientPackagePreview({ preview }: Props) {
  const client = useTRPCClient()
  const [feedback, setFeedback] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const writeInFlight = useRef(false)
  const operation = useRef(crypto.randomUUID())
  const { venue, experience } = preview
  const accent = /^#[0-9a-f]{6}$/i.test(venue.branding.accentColor ?? '')
    ? venue.branding.accentColor!
    : '#326b73'
  const supportHref = `/support?${new URLSearchParams({ venue: venue.id })}`

  async function submitFeedback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = feedback.trim()
    if (writeInFlight.current || !body) return
    writeInFlight.current = true
    setPending(true)
    setError(null)
    try {
      await client.portal.createPreviewFeedbackRequest.mutate({
        operationId: operation.current,
        venueId: venue.id,
        packageId: preview.package.id,
        body,
        attachments: [],
      })
      setFeedback('')
      setSent(true)
      operation.current = crypto.randomUUID()
    } catch (submitError) {
      const code = errorCode(submitError)
      setError(
        code === 'CONFLICT' || code === 'NOT_FOUND'
          ? 'This approved preview changed or is no longer available. Your message is retained; return home for the latest preview.'
          : 'The feedback outcome could not be confirmed. Your message is retained; retry unchanged to check the original request.',
      )
    } finally {
      writeInFlight.current = false
      setPending(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f1ea] px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <nav
          aria-label="Preview navigation"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <Link
            href={`/?venue=${encodeURIComponent(venue.id)}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-sm font-semibold text-pf-deep"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to home
          </Link>
          <a
            href="#preview-feedback"
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-pf-light bg-white px-5 text-sm font-semibold text-pf-primary"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" /> Send preview feedback
          </a>
        </nav>

        <section className="overflow-hidden rounded-[2rem] bg-pf-deep text-white shadow-xl">
          {venue.branding.bannerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- tenant branding is a validated remote URL and must not require an image-host allowlist.
            <img
              src={venue.branding.bannerUrl}
              alt=""
              className="h-48 w-full object-cover sm:h-64"
            />
          ) : null}
          <div className="grid gap-8 px-6 py-8 sm:px-10 sm:py-12 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Approved preview - not live
              </div>
              <div className="mt-6 flex items-center gap-4">
                {venue.branding.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- tenant branding is a validated remote URL and must not require an image-host allowlist.
                  <img
                    src={venue.branding.logoUrl}
                    alt=""
                    className="h-14 w-14 rounded-2xl bg-white object-contain p-2"
                  />
                ) : null}
                <div>
                  <p className="text-sm text-white/70">Visitor experience preview</p>
                  <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-5xl">
                    {venue.name}
                  </h1>
                </div>
              </div>
              {venue.description ? (
                <p className="mt-5 max-w-3xl text-base leading-7 text-white/80">
                  {venue.description}
                </p>
              ) : null}
            </div>
            <div className="rounded-3xl bg-white/10 p-5 text-sm leading-6">
              <p className="font-semibold">What you are reviewing</p>
              <p className="mt-1 text-white/75">
                The approved visitor content and configuration for your review. Presentation here is
                simplified and it has not been published to visitors.
              </p>
            </div>
          </div>
          <div className="h-1.5" style={{ backgroundColor: accent }} />
        </section>

        <section aria-labelledby="places-heading">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-pf-primary">Explore</p>
              <h2 id="places-heading" className="mt-1 text-2xl font-semibold text-pf-deep">
                Places visitors can discover
              </h2>
            </div>
            <p className="text-sm text-pf-deep/65">
              {experience.summary.placeCount}{' '}
              {experience.summary.placeCount === 1 ? 'place' : 'places'}
            </p>
          </div>
          {experience.places.length ? (
            <ul className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {experience.places.map((place, index) => (
                <li
                  key={`${place.name}:${place.type}:${index}`}
                  className="overflow-hidden rounded-[1.75rem] border border-pf-light bg-white shadow-sm"
                >
                  {place.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- preview URLs are validated and intentionally render without a deployment host allowlist.
                    <img src={place.photoUrl} alt="" className="h-44 w-full object-cover" />
                  ) : null}
                  <article className="p-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-pf-primary">
                      {place.type.replace(/_/g, ' ')}
                    </p>
                    <h3 className="mt-2 text-xl font-semibold text-pf-deep">{place.name}</h3>
                    {place.shortDescription || place.longDescription ? (
                      <p className="mt-3 text-sm leading-6 text-pf-deep/75">
                        {place.shortDescription ?? place.longDescription}
                      </p>
                    ) : null}
                    <ul
                      className="mt-4 space-y-2 text-sm text-pf-deep/70"
                      aria-label={`${place.name} details`}
                    >
                      {place.areaName ? (
                        <li className="flex gap-2">
                          <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <div>
                            <span className="sr-only">Area: </span>
                            {place.areaName}
                          </div>
                        </li>
                      ) : null}
                      {place.hours ? (
                        <li className="flex gap-2">
                          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <div>
                            <span className="sr-only">Hours: </span>
                            {place.hours}
                          </div>
                        </li>
                      ) : null}
                      {place.lat !== null && place.lng !== null ? (
                        <li className="flex gap-2">
                          <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <div>
                            <span>Map location included</span>
                          </div>
                        </li>
                      ) : null}
                    </ul>
                    {place.tags.length ? (
                      <ul
                        aria-label={`${place.name} highlights`}
                        className="mt-4 flex flex-wrap gap-2"
                      >
                        {place.tags.map((tag) => (
                          <li
                            key={tag}
                            className="rounded-full bg-pf-surface px-3 py-1 text-xs text-pf-deep/70"
                          >
                            {tag}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-[1.75rem] border border-dashed border-pf-light bg-white p-8 text-sm text-pf-deep/70">
              No visitor places are included in this preview yet.
            </p>
          )}
        </section>

        <section
          aria-labelledby="answers-heading"
          className="rounded-[2rem] bg-white p-6 shadow-sm sm:p-8"
        >
          <div className="flex items-center gap-3">
            <span className="rounded-2xl bg-pf-surface p-3">
              <Sparkles className="h-5 w-5 text-pf-primary" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm text-pf-deep/60">
                {venue.guide.name ?? 'PathFinder guide'}
                {` · ${venue.guide.tone.preset} voice`}
              </p>
              <h2 id="answers-heading" className="text-2xl font-semibold text-pf-deep">
                Helpful visitor information
              </h2>
            </div>
          </div>
          {experience.knowledgeEntries.length ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {experience.knowledgeEntries.map((entry, index) => (
                <article
                  key={`${entry.title}:${entry.category}:${index}`}
                  className="rounded-2xl border border-pf-light p-5"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-pf-primary">
                    {entry.category}
                  </p>
                  <h3 className="mt-2 text-lg font-semibold text-pf-deep">{entry.title}</h3>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-pf-deep/75">
                    {entry.content}
                  </p>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-5 rounded-2xl bg-pf-surface p-5 text-sm text-pf-deep/70">
              No visitor answers are included in this preview yet.
            </p>
          )}
        </section>

        <section
          id="preview-feedback"
          className="rounded-[2rem] border border-pf-light bg-white p-6 shadow-sm sm:p-8"
        >
          <h2 className="text-xl font-semibold text-pf-deep">
            Does this feel ready for your visitors?
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/70">
            Send corrections or questions to PathFinder Support. This preview cannot publish or
            change the visitor experience.
          </p>
          <form
            onSubmit={(event) => void submitFeedback(event)}
            className="mt-5 max-w-2xl space-y-3"
            aria-busy={pending}
          >
            <label className="block text-left text-sm font-semibold text-pf-deep">
              Feedback
              <textarea
                required
                maxLength={20_000}
                rows={5}
                value={feedback}
                disabled={pending}
                onChange={(event) => {
                  setFeedback(event.target.value)
                  setError(null)
                  setSent(false)
                  operation.current = crypto.randomUUID()
                }}
                className="mt-2 block w-full rounded-2xl border border-pf-light px-4 py-3 font-normal leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                placeholder="Tell us what feels right or what should change."
              />
            </label>
            <button
              type="submit"
              disabled={pending || !feedback.trim()}
              className="inline-flex min-h-12 items-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? 'Sending feedback...' : 'Send preview feedback'}
            </button>
          </form>
          {error ? (
            <p
              role="alert"
              className="mt-4 max-w-2xl rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
            >
              {error}
            </p>
          ) : null}
          {sent ? (
            <div
              role="status"
              className="mt-4 max-w-2xl rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
            >
              <p>Your feedback was sent to PathFinder Support. Nothing was published.</p>
              <Link
                href={supportHref}
                className="mt-2 inline-flex font-semibold underline underline-offset-2"
              >
                Open Support
              </Link>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}
