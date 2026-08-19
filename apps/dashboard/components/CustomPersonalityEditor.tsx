'use client'

import { useState } from 'react'

import type { PersonalityProfileSnapshot } from '@pathfinder/contracts'

import { useTRPCClient } from '../lib/trpc'

const initialBounds = { warmth: 0.7, brevity: 0.7, energy: 0.5, formality: 0.5 }

export function CustomPersonalityEditor({
  venueId,
  profiles,
  selectedProfileId,
  disabled,
  onSelect,
  onSaved,
}: {
  venueId: string
  profiles: PersonalityProfileSnapshot[]
  selectedProfileId: string | null
  disabled: boolean
  onSelect: (profileId: string) => void
  onSaved: (profile: PersonalityProfileSnapshot) => void
}) {
  const client = useTRPCClient()
  const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? null
  const [editingId, setEditingId] = useState<string | null>(selected?.id ?? null)
  const editing = profiles.find((profile) => profile.id === editingId) ?? null
  const [name, setName] = useState(editing?.name ?? 'My Venue Bot style')
  const [bounds, setBounds] = useState(editing?.bounds ?? initialBounds)
  const [instruction, setInstruction] = useState(editing?.bounds.customInstruction ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function begin(profile: PersonalityProfileSnapshot | null) {
    setEditingId(profile?.id ?? null)
    setName(profile?.name ?? 'My Venue Bot style')
    setBounds(profile?.bounds ?? initialBounds)
    setInstruction(profile?.bounds.customInstruction ?? '')
    setError(null)
  }

  async function save() {
    if (saving) return
    setSaving(true)
    setError(null)
    const profile = {
      name,
      bounds: {
        ...bounds,
        ...(instruction.trim() ? { customInstruction: instruction.trim() } : {}),
      },
    }
    try {
      const saved = editing
        ? await client.venue.updatePersonalityProfile.mutate({
            venueId,
            profileId: editing.id,
            expectedRevision: editing.revision,
            profile,
          })
        : await client.venue.createPersonalityProfile.mutate({ venueId, profile })
      onSaved(saved)
      onSelect(saved.id)
      setEditingId(saved.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Custom personality could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-6 border-t border-pf-light pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-pf-deep">Custom personality</h3>
          <p className="mt-1 text-sm text-pf-deep/65">
            Style controls never change Venue Bot&apos;s factual, privacy, or safety rules.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || saving}
          onClick={() => begin(null)}
          className="min-h-11 border border-pf-light px-4 text-sm font-semibold text-pf-primary hover:border-pf-accent disabled:opacity-50"
        >
          New profile
        </button>
      </div>

      {profiles.length > 0 ? (
        <label className="mt-5 block text-sm font-semibold text-pf-deep">
          Saved profile
          <select
            value={selectedProfileId ?? ''}
            disabled={disabled || saving}
            onChange={(event) => {
              const profile = profiles.find((candidate) => candidate.id === event.target.value)
              if (!profile) return
              onSelect(profile.id)
              begin(profile)
            }}
            className="mt-2 min-h-11 w-full border border-pf-light bg-white px-3 font-normal"
          >
            <option value="" disabled>
              Choose a profile
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mt-5 grid gap-5 border-l-2 border-pf-primary/20 pl-5 sm:grid-cols-2">
        <label className="text-sm font-semibold text-pf-deep sm:col-span-2">
          Profile name
          <input
            value={name}
            maxLength={120}
            disabled={disabled || saving}
            onChange={(event) => setName(event.target.value)}
            className="mt-2 min-h-11 w-full border border-pf-light px-3 font-normal"
          />
        </label>
        {(
          [
            ['warmth', 'Warmth'],
            ['brevity', 'Brevity'],
            ['energy', 'Energy'],
            ['formality', 'Formality'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="text-sm font-semibold text-pf-deep">
            <span className="flex justify-between gap-3">
              {label} <span>{Math.round(bounds[key] * 100)}</span>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round(bounds[key] * 100)}
              disabled={disabled || saving}
              onChange={(event) =>
                setBounds((current) => ({ ...current, [key]: Number(event.target.value) / 100 }))
              }
              className="mt-2 min-h-11 w-full accent-pf-primary"
            />
          </label>
        ))}
        <label className="text-sm font-semibold text-pf-deep sm:col-span-2">
          Optional style note
          <textarea
            value={instruction}
            maxLength={500}
            rows={3}
            disabled={disabled || saving}
            onChange={(event) => setInstruction(event.target.value)}
            className="mt-2 w-full border border-pf-light px-3 py-2 font-normal"
          />
          <span className="mt-1 block text-xs font-normal text-pf-deep/70">
            {instruction.length}/500. This cannot override platform rules.
          </span>
        </label>
      </div>

      <button
        type="button"
        disabled={disabled || saving || !name.trim()}
        onClick={() => void save()}
        className="mt-5 min-h-11 bg-pf-deep px-5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Saving profile…' : editing ? 'Update custom profile' : 'Save custom profile'}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
