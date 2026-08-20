'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { useTRPCClient } from '../../lib/trpc'

function optional(form: FormData, name: string) {
  const value = String(form.get(name) ?? '').trim()
  return value || undefined
}

export function ProspectCreateForm() {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const form = new FormData(event.currentTarget)
    const venueName = optional(form, 'venueName')
    const contactName = optional(form, 'contactName')
    const contactEmail = optional(form, 'contactEmail')
    const contactPhone = optional(form, 'contactPhone')
    try {
      const result = await client.admin.createProspect.mutate({
        organization: {
          canonicalName: String(form.get('organizationName') ?? '').trim(),
          ...(optional(form, 'website') ? { website: optional(form, 'website') } : {}),
          ...(optional(form, 'organizationType')
            ? { organizationType: optional(form, 'organizationType') }
            : {}),
          ...(optional(form, 'source')
            ? { source: optional(form, 'source') }
            : { source: 'manual' }),
          priority: String(form.get('priority') ?? 'NORMAL') as
            | 'LOW'
            | 'NORMAL'
            | 'HIGH'
            | 'URGENT',
          ...(optional(form, 'notes') ? { notes: optional(form, 'notes') } : {}),
        },
        ...(venueName
          ? {
              venue: {
                name: venueName,
                ...(optional(form, 'venueType') ? { venueType: optional(form, 'venueType') } : {}),
                ...(optional(form, 'city') ? { city: optional(form, 'city') } : {}),
                ...(optional(form, 'region') ? { region: optional(form, 'region') } : {}),
              },
            }
          : {}),
        ...(contactName || contactEmail || contactPhone
          ? {
              contact: {
                ...(contactName ? { fullName: contactName } : {}),
                ...(optional(form, 'contactTitle')
                  ? { title: optional(form, 'contactTitle') }
                  : {}),
                ...(contactEmail ? { email: contactEmail } : {}),
                ...(contactPhone ? { phone: contactPhone } : {}),
                source: 'manual',
              },
            }
          : {}),
      })
      router.push(`/admin/prospects/${result.organization.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The prospect could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass =
    'mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 text-sm text-slate-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100'
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/prospects" className="text-sm font-semibold text-sky-700">
          Back to directory
        </Link>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
          Manual research capture
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Add a prospect</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Create the organization first, with an optional location and contact. Exact name, domain,
          or email matches are stopped for duplicate review.
        </p>
      </div>
      <form
        onSubmit={(event) => void submit(event)}
        className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <fieldset className="grid gap-4 md:grid-cols-2">
          <legend className="mb-3 font-semibold text-slate-950">Organization</legend>
          <label className="text-xs font-semibold text-slate-600">
            Organization name *
            <input name="organizationName" required maxLength={300} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Website
            <input name="website" type="url" maxLength={2000} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Organization type
            <input name="organizationType" maxLength={200} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Priority
            <select name="priority" defaultValue="NORMAL" className={inputClass}>
              <option value="LOW">Low</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">High</option>
              <option value="URGENT">Urgent</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 md:col-span-2">
            Source
            <input
              name="source"
              maxLength={500}
              placeholder="Research source or referral"
              className={inputClass}
            />
          </label>
        </fieldset>
        <fieldset className="grid gap-4 border-t border-slate-200 pt-5 md:grid-cols-2">
          <legend className="mb-3 font-semibold text-slate-950">
            Venue or location <span className="font-normal text-slate-400">(optional)</span>
          </legend>
          <label className="text-xs font-semibold text-slate-600">
            Venue name
            <input name="venueName" maxLength={300} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Venue type
            <input name="venueType" maxLength={200} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            City
            <input name="city" maxLength={200} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            State / region
            <input name="region" maxLength={100} className={inputClass} />
          </label>
        </fieldset>
        <fieldset className="grid gap-4 border-t border-slate-200 pt-5 md:grid-cols-2">
          <legend className="mb-3 font-semibold text-slate-950">
            Contact <span className="font-normal text-slate-400">(optional)</span>
          </legend>
          <label className="text-xs font-semibold text-slate-600">
            Name
            <input name="contactName" maxLength={300} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Title
            <input name="contactTitle" maxLength={300} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Email
            <input name="contactEmail" type="email" maxLength={320} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            Phone
            <input name="contactPhone" maxLength={200} className={inputClass} />
          </label>
          <label className="text-xs font-semibold text-slate-600 md:col-span-2">
            Notes
            <textarea name="notes" maxLength={10000} rows={4} className={`${inputClass} py-3`} />
          </label>
        </fieldset>
        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create prospect
          </button>
        </div>
      </form>
    </div>
  )
}
