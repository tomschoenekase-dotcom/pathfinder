'use client'

import { useState } from 'react'
import Link from 'next/link'

import { useTRPCClient } from '../lib/trpc'

type Props = {
  venueId: string
  enabled: boolean
  initialLabel: string
  initialUrl: string | null
  initialUpdatedAt: string
}

export function SecondLayerSettings({
  venueId,
  enabled,
  initialLabel,
  initialUrl,
  initialUpdatedAt,
}: Props) {
  const client = useTRPCClient()
  const [label, setLabel] = useState(initialLabel)
  const [url, setUrl] = useState(initialUrl)
  const [pending, setPending] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt)
  const [message, setMessage] = useState<string | null>(null)

  if (!enabled) return null

  async function save(rotateLink: boolean) {
    if (pending || !label.trim()) return
    if (
      rotateLink &&
      !window.confirm('Rotate this private link? The current link will stop working.')
    )
      return
    setPending(true)
    setMessage(null)
    try {
      const result = await client.venue.updateSecondLayer.mutate({
        venueId,
        label: label.trim(),
        rotateLink,
        expectedUpdatedAt: new Date(updatedAt),
      })
      if (rotateLink && url) {
        const current = new URL(url)
        const parts = current.pathname.split('/')
        parts[parts.length - 2] = result.accessKey
        current.pathname = parts.join('/')
        setUrl(current.toString())
      }
      setLabel(result.label)
      setUpdatedAt(result.updatedAt.toISOString())
      setMessage(rotateLink ? 'Private link rotated.' : 'Layer label saved.')
    } catch {
      setMessage('The second-layer settings could not be saved. Refresh and try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded-[2rem] border border-pf-primary/20 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-sm font-medium text-pf-primary">Premium add-on</p>
      <h2 className="mt-1 text-xl font-semibold text-pf-deep">Second chatbot layer</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/65">
        This link sees public guide items plus items tagged for this additional layer. Anyone with
        the link can open it, so rotate it if it is shared outside the intended group.
      </p>
      <label className="mt-5 block text-sm font-medium text-pf-deep" htmlFor="second-layer-label">
        Layer label
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id="second-layer-label"
          value={label}
          maxLength={40}
          disabled={pending}
          onChange={(event) => setLabel(event.target.value)}
          className="min-h-11 flex-1 rounded-2xl border border-pf-light px-4 text-sm text-pf-deep outline-none focus:border-pf-accent"
        />
        <button
          type="button"
          disabled={pending || !label.trim()}
          onClick={() => void save(false)}
          className="min-h-11 rounded-full bg-pf-primary px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Save label
        </button>
      </div>
      {url ? (
        <div className="mt-5 rounded-2xl bg-pf-surface p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-pf-deep/45">
            Private chatbot link
          </p>
          <a
            className="mt-2 block break-all text-sm font-medium text-pf-primary underline"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {url}
          </a>
          <button
            type="button"
            disabled={pending}
            onClick={() => void save(true)}
            className="mt-3 text-sm font-semibold text-rose-700 disabled:opacity-50"
          >
            Rotate private link
          </button>
        </div>
      ) : null}
      <Link
        href={`/venues/${encodeURIComponent(venueId)}/second-layer`}
        className="mt-5 inline-flex min-h-11 items-center rounded-full border border-pf-primary px-5 text-sm font-semibold text-pf-primary"
      >
        Tag guide items for {label}
      </Link>
      {message ? (
        <p className="mt-3 text-sm text-pf-deep/65" role="status">
          {message}
        </p>
      ) : null}
    </section>
  )
}
