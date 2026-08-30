'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'
import { ApprovalDecisionForm } from './ApprovalDecisionForm'
import {
  VenueLocationTopologyAuthoring,
  type TopologyConnection,
  type TopologyFloor,
} from './VenueLocationTopologyAuthoring'

type Location = {
  id: string
  stableKey: string
  kind: string
  displayName: string
  description: string | null
  visibility: string
  floorId: string | null
  parentLocationId: string | null
  coordinates: { latitude: number; longitude: number } | null
  mapAnchor: { x: number; y: number } | null
  externalMapReference: string | null
  accessibilityMetadata?: unknown
  isActive: boolean
  verifiedAt: Date
  updatedAt: Date
}

type Floor = TopologyFloor

type LocationProposal = {
  id: string
  reason: string
  createdAt: Date
  proposedBy: string
  draft: {
    stableKey: string
    kind: string
    displayName: string
    visibility: string
  } | null
  decision: {
    id: string
    outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
    decidedByType: string
    createdAt: Date
    applied: boolean
  } | null
}

type Props = {
  tenantId: string
  venueId: string
  venueName: string
  floors: Floor[]
  initialLocations: Location[]
  connectionCount?: number
  connections?: TopologyConnection[]
  proposals?: LocationProposal[]
}

const kinds = [
  'VENUE',
  'FLOOR',
  'ZONE',
  'ROOM',
  'POI',
  'ENTRANCE',
  'EXIT',
  'RESTROOM',
  'EXHIBIT',
  'ACCESSIBILITY_POINT',
  'SERVICE_DESK',
  'FOOD',
  'PARKING',
] as const

const optionalNumber = (form: FormData, name: string) => {
  const raw = String(form.get(name) ?? '').trim()
  return raw ? Number(raw) : null
}

const scalarMetadata = (value: unknown): Record<string, string | number | boolean> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string | number | boolean] =>
      ['string', 'number', 'boolean'].includes(typeof entry[1]),
    ),
  )
}

function ApprovedProposalApplication({
  tenantId,
  venueId,
  proposal,
}: {
  tenantId: string
  venueId: string
  proposal: LocationProposal
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function apply() {
    if (!proposal.decision || !reason.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.applyApprovedVenueLocationDraft.mutate({
        tenantId,
        venueId,
        approvalRequestId: proposal.id,
        expectedDecisionAt: proposal.decision.createdAt,
        reason: reason.trim(),
      })
      setMessage('Approved proposal applied as an inactive draft. Activation remains separate.')
      setReason('')
      router.refresh()
    } catch {
      setMessage('The proposal was not applied. Refresh its approval and location state.')
    } finally {
      setBusy(false)
    }
  }

  if (proposal.decision?.applied) {
    return (
      <p className="mt-3 text-sm font-semibold text-emerald-800">Applied as an inactive draft.</p>
    )
  }
  return (
    <div className="mt-4 border-t border-emerald-200 pt-4">
      <label className="block text-xs font-semibold text-pf-deep/75">
        Application reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          placeholder="Why is this approved proposal ready to become a draft?"
          className="mt-1 min-h-11 w-full rounded-xl border border-emerald-200 px-3 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => void apply()}
        disabled={busy || !reason.trim()}
        className="mt-2 min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Applying…' : 'Create inactive draft'}
      </button>
      {message ? (
        <p className="mt-2 text-sm text-pf-deep/75" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}

function AvailabilityControl({
  tenantId,
  venueId,
  location,
}: {
  tenantId: string
  venueId: string
  location: Location
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function changeAvailability() {
    if (!reason.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.setVenueLocationAvailability.mutate({
        tenantId,
        venueId,
        locationId: location.id,
        expectedUpdatedAt: location.updatedAt,
        active: !location.isActive,
        reason: reason.trim(),
      })
      setMessage(location.isActive ? 'Location removed from guest lookup.' : 'Location activated.')
      setReason('')
      router.refresh()
    } catch {
      setMessage('The location was not changed. Refresh and review the current version.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 border-t border-pf-light pt-4">
      <label className="block text-xs font-semibold text-pf-deep/75">
        Review reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          placeholder={
            location.isActive
              ? 'Why should this leave guest lookup?'
              : 'What source confirms this anchor?'
          }
          className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => void changeAvailability()}
        disabled={busy || !reason.trim()}
        className="mt-2 min-h-11 rounded-xl bg-pf-primary px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Saving…' : location.isActive ? 'Deactivate anchor' : 'Activate verified anchor'}
      </button>
      {message ? (
        <p className="mt-2 text-sm text-pf-deep/75" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}

function DraftEditControl({
  tenantId,
  venueId,
  location,
  floors,
  parentOptions,
}: {
  tenantId: string
  venueId: string
  location: Location
  floors: Floor[]
  parentOptions: Location[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function updateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const latitude = optionalNumber(form, 'latitude')
    const longitude = optionalNumber(form, 'longitude')
    const mapX = optionalNumber(form, 'mapX')
    const mapY = optionalNumber(form, 'mapY')
    if ((latitude === null) !== (longitude === null) || (mapX === null) !== (mapY === null)) {
      setMessage('Enter both values in a coordinate pair, or leave both blank.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.updateVenueLocationDraft.mutate({
        tenantId,
        venueId,
        locationId: location.id,
        expectedUpdatedAt: location.updatedAt,
        reason: String(form.get('reason') ?? ''),
        stableKey: String(form.get('stableKey') ?? ''),
        kind: String(form.get('kind') ?? 'POI') as (typeof kinds)[number],
        displayName: String(form.get('displayName') ?? ''),
        description: String(form.get('description') ?? '').trim() || null,
        visibility: String(form.get('visibility') ?? 'PUBLIC') as 'PUBLIC' | 'SECOND_LAYER',
        floorId: String(form.get('floorId') ?? '').trim() || null,
        parentLocationId: String(form.get('parentLocationId') ?? '').trim() || null,
        coordinates: latitude !== null && longitude !== null ? { latitude, longitude } : null,
        mapAnchor: mapX !== null && mapY !== null ? { x: mapX, y: mapY } : null,
        externalMapReference: String(form.get('externalMapReference') ?? '').trim() || null,
        accessibilityMetadata: scalarMetadata(location.accessibilityMetadata),
      })
      setMessage('Draft updated. It still requires separate activation review.')
      router.refresh()
    } catch {
      setMessage('The draft was not updated. Refresh and review its current version.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-4 rounded-2xl border border-pf-light p-4">
      <summary className="cursor-pointer text-sm font-semibold text-pf-primary">Edit draft</summary>
      <form
        onSubmit={(event) => void updateDraft(event)}
        className="mt-4 grid gap-3 sm:grid-cols-2"
      >
        <label className="text-xs font-semibold text-pf-deep/75">
          Display name
          <input
            name="displayName"
            required
            defaultValue={location.displayName}
            maxLength={191}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Stable key
          <input
            name="stableKey"
            required
            defaultValue={location.stableKey}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            maxLength={100}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Kind
          <select
            name="kind"
            defaultValue={location.kind}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Visibility
          <select
            name="visibility"
            defaultValue={location.visibility}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          >
            <option value="PUBLIC">Public guest experience</option>
            <option value="SECOND_LAYER">Authorized second layer</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Floor
          <select
            name="floorId"
            defaultValue={location.floorId ?? ''}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          >
            <option value="">No floor</option>
            {floors
              .filter((floor) => floor.isActive)
              .map((floor) => (
                <option key={floor.id} value={floor.id}>
                  {floor.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Parent anchor
          <select
            name="parentLocationId"
            defaultValue={location.parentLocationId ?? ''}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          >
            <option value="">No parent</option>
            {parentOptions
              .filter((parent) => parent.id !== location.id)
              .map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.displayName}
                </option>
              ))}
          </select>
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Description
          <textarea
            name="description"
            defaultValue={location.description ?? ''}
            maxLength={2000}
            rows={2}
            className="mt-1 w-full rounded-xl border border-pf-light p-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Latitude
          <input
            aria-label="Edit latitude"
            name="latitude"
            type="number"
            step="0.0000001"
            min={-90}
            max={90}
            defaultValue={location.coordinates?.latitude}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Longitude
          <input
            aria-label="Edit longitude"
            name="longitude"
            type="number"
            step="0.0000001"
            min={-180}
            max={180}
            defaultValue={location.coordinates?.longitude}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Map X
          <input
            aria-label="Edit map X"
            name="mapX"
            type="number"
            step="0.0001"
            defaultValue={location.mapAnchor?.x}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Map Y
          <input
            aria-label="Edit map Y"
            name="mapY"
            type="number"
            step="0.0001"
            defaultValue={location.mapAnchor?.y}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Public HTTPS map URL
          <input
            name="externalMapReference"
            type="url"
            maxLength={2000}
            defaultValue={location.externalMapReference ?? ''}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Change reason
          <input
            name="reason"
            required
            maxLength={500}
            placeholder="What changed, and what source supports it?"
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
          />
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 rounded-xl border border-pf-primary px-4 py-2 text-sm font-semibold text-pf-primary disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Update review-only draft'}
          </button>
          {message ? (
            <p className="mt-2 text-sm text-pf-deep/75" role="status">
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </details>
  )
}

export function VenueLocationAuthoring({
  tenantId,
  venueId,
  venueName,
  floors,
  initialLocations,
  connectionCount = 0,
  connections = [],
  proposals = [],
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const latitude = optionalNumber(form, 'latitude')
    const longitude = optionalNumber(form, 'longitude')
    const mapX = optionalNumber(form, 'mapX')
    const mapY = optionalNumber(form, 'mapY')
    if ((latitude === null) !== (longitude === null) || (mapX === null) !== (mapY === null)) {
      setMessage('Enter both values in a coordinate pair, or leave both blank.')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.createVenueLocationDraft.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        stableKey: String(form.get('stableKey') ?? ''),
        kind: String(form.get('kind') ?? 'POI') as (typeof kinds)[number],
        displayName: String(form.get('displayName') ?? ''),
        description: String(form.get('description') ?? '').trim() || null,
        visibility: String(form.get('visibility') ?? 'PUBLIC') as 'PUBLIC' | 'SECOND_LAYER',
        floorId: String(form.get('floorId') ?? '').trim() || null,
        parentLocationId: String(form.get('parentLocationId') ?? '').trim() || null,
        coordinates: latitude !== null && longitude !== null ? { latitude, longitude } : null,
        mapAnchor: mapX !== null && mapY !== null ? { x: mapX, y: mapY } : null,
        externalMapReference: String(form.get('externalMapReference') ?? '').trim() || null,
        accessibilityMetadata: {},
      })
      formElement.reset()
      setMessage(
        'Draft saved. It remains invisible to guests until separately reviewed and activated.',
      )
      router.refresh()
    } catch {
      setMessage('The draft was not saved. Check the stable key, scope, and public map URL.')
    } finally {
      setBusy(false)
    }
  }

  const activeLocations = initialLocations.filter((location) => location.isActive)

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Verified visitor anchors
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-pf-deep">Location authoring</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Create structured anchors for {venueName}. New records are review-only drafts. A separate,
          reasoned activation makes a public anchor available to guest lookup; it does not create
          turn-by-turn routing.
        </p>
      </header>

      <VenueLocationTopologyAuthoring
        tenantId={tenantId}
        venueId={venueId}
        floors={floors}
        locations={initialLocations}
        connections={connections}
      />

      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6">
        <h3 className="text-lg font-semibold text-pf-deep">Create an inactive draft</h3>
        <form
          onSubmit={(event) => void createDraft(event)}
          className="mt-4 grid gap-4 md:grid-cols-2"
        >
          <label className="text-sm font-semibold text-pf-deep">
            Display name
            <input
              name="displayName"
              required
              maxLength={191}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Stable key
            <input
              name="stableKey"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="east-entrance"
              maxLength={100}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Kind
            <select
              name="kind"
              defaultValue="POI"
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Visibility
            <select
              name="visibility"
              defaultValue="PUBLIC"
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            >
              <option value="PUBLIC">Public guest experience</option>
              <option value="SECOND_LAYER">Authorized second layer</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Floor
            <select
              name="floorId"
              defaultValue=""
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            >
              <option value="">No floor</option>
              {floors
                .filter((floor) => floor.isActive)
                .map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name} · {floor.stableKey}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-sm font-semibold text-pf-deep">
            Parent anchor
            <select
              name="parentLocationId"
              defaultValue=""
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            >
              <option value="">No parent</option>
              {activeLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="md:col-span-2 text-sm font-semibold text-pf-deep">
            Description
            <textarea
              name="description"
              maxLength={2000}
              rows={3}
              className="mt-1 w-full rounded-xl border border-pf-light p-3"
            />
          </label>
          <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-pf-light p-4">
            <legend className="px-1 text-sm font-semibold text-pf-deep">GPS pair (optional)</legend>
            <label className="text-xs font-semibold text-pf-deep/75">
              Latitude
              <input
                name="latitude"
                type="number"
                step="0.0000001"
                min={-90}
                max={90}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="text-xs font-semibold text-pf-deep/75">
              Longitude
              <input
                name="longitude"
                type="number"
                step="0.0000001"
                min={-180}
                max={180}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
          </fieldset>
          <fieldset className="grid grid-cols-2 gap-3 rounded-2xl border border-pf-light p-4">
            <legend className="px-1 text-sm font-semibold text-pf-deep">
              Map anchor pair (optional)
            </legend>
            <label className="text-xs font-semibold text-pf-deep/75">
              X
              <input
                name="mapX"
                type="number"
                step="0.0001"
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="text-xs font-semibold text-pf-deep/75">
              Y
              <input
                name="mapY"
                type="number"
                step="0.0001"
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
          </fieldset>
          <label className="md:col-span-2 text-sm font-semibold text-pf-deep">
            Public HTTPS map URL (optional)
            <input
              name="externalMapReference"
              type="url"
              inputMode="url"
              maxLength={2000}
              placeholder="https://…"
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 rounded-xl bg-pf-primary px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save review-only draft'}
            </button>
            {message ? (
              <p className="mt-3 text-sm text-pf-deep/75" role="status">
                {message}
              </p>
            ) : null}
          </div>
        </form>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-pf-deep">Anchors</h3>
            <p className="mt-1 text-sm text-pf-deep/65">
              {activeLocations.length} active · {initialLocations.length - activeLocations.length}{' '}
              inactive · {connections.length || connectionCount} existing connection(s)
            </p>
          </div>
        </div>
        {initialLocations.length ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {initialLocations.map((location) => (
              <article
                key={location.id}
                className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-pf-deep">{location.displayName}</h4>
                    <p className="mt-1 text-xs uppercase tracking-wide text-pf-deep/60">
                      {location.kind.replaceAll('_', ' ')} · {location.stableKey}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-bold ${location.isActive ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}
                  >
                    {location.isActive ? 'Active' : 'Review only'}
                  </span>
                </div>
                {location.description ? (
                  <p className="mt-3 text-sm text-pf-deep/75">{location.description}</p>
                ) : null}
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-pf-deep/65">
                  <div>
                    <dt className="font-semibold">Visibility</dt>
                    <dd>{location.visibility.replaceAll('_', ' ')}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Verified</dt>
                    <dd>{new Date(location.verifiedAt).toLocaleDateString()}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold">GPS</dt>
                    <dd>
                      {location.coordinates
                        ? `${location.coordinates.latitude}, ${location.coordinates.longitude}`
                        : 'Not set'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Map anchor</dt>
                    <dd>
                      {location.mapAnchor
                        ? `${location.mapAnchor.x}, ${location.mapAnchor.y}`
                        : 'Not set'}
                    </dd>
                  </div>
                </dl>
                {location.externalMapReference ? (
                  <a
                    href={location.externalMapReference}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex text-sm font-semibold text-pf-primary underline"
                  >
                    Review public map <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : null}
                {!location.isActive ? (
                  <DraftEditControl
                    tenantId={tenantId}
                    venueId={venueId}
                    location={location}
                    floors={floors}
                    parentOptions={activeLocations}
                  />
                ) : null}
                <AvailabilityControl tenantId={tenantId} venueId={venueId} location={location} />
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-3xl border border-dashed border-pf-light bg-pf-surface p-8 text-center">
            <h4 className="font-semibold text-pf-deep">No location anchors yet</h4>
            <p className="mt-2 text-sm text-pf-deep/65">
              Create a review-only draft above. Nothing is exposed to guests automatically.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-6">
        <h3 className="text-lg font-semibold text-pf-deep">AI location proposals</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Agents can prepare typed anchors, but cannot change venue content. A human decision and a
          separate application are both required; application creates an inactive draft only.
        </p>
        {proposals.length ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {proposals.map((proposal) => (
              <article key={proposal.id} className="rounded-2xl border border-pf-light p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-pf-deep">
                      {proposal.draft?.displayName ?? 'Unsupported proposal payload'}
                    </h4>
                    <p className="mt-1 text-xs uppercase tracking-wide text-pf-deep/60">
                      {proposal.draft
                        ? `${proposal.draft.kind.replaceAll('_', ' ')} · ${proposal.draft.stableKey}`
                        : 'Cannot apply'}
                    </p>
                  </div>
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-950">
                    {proposal.decision?.outcome ?? 'PENDING REVIEW'}
                  </span>
                </div>
                <p className="mt-3 text-sm text-pf-deep/75">{proposal.reason}</p>
                <p className="mt-2 text-xs text-pf-deep/60">
                  Proposed by {proposal.proposedBy} ·{' '}
                  {new Date(proposal.createdAt).toLocaleDateString()}
                </p>
                {!proposal.decision && proposal.draft ? (
                  <ApprovalDecisionForm
                    tenantId={tenantId}
                    venueId={venueId}
                    approvalRequestId={proposal.id}
                    proposedAction="torchiko.locations.create_draft"
                  />
                ) : null}
                {proposal.decision?.outcome === 'APPROVED' &&
                proposal.decision.decidedByType === 'HUMAN' &&
                proposal.draft ? (
                  <ApprovedProposalApplication
                    tenantId={tenantId}
                    venueId={venueId}
                    proposal={proposal}
                  />
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-dashed border-pf-light bg-pf-surface p-6 text-center">
            <p className="font-semibold text-pf-deep">No AI location proposals</p>
            <p className="mt-1 text-sm text-pf-deep/65">
              The empty state is healthy. Direct agent mutation remains unavailable.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
