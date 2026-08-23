'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

export type TopologyFloor = {
  id: string
  stableKey: string
  name: string
  level: number | null
  sortOrder: number
  mapImageUrl: string | null
  isActive: boolean
  updatedAt: Date
}

export type TopologyLocation = {
  id: string
  displayName: string
  stableKey: string
  isActive: boolean
}

export type TopologyConnection = {
  id: string
  fromLocationId: string
  toLocationId: string
  kind: string
  bidirectional: boolean
  accessible: boolean
  directions: string | null
  isActive: boolean
  verifiedAt: Date
  updatedAt: Date
}

const connectionKinds = [
  'WALKWAY',
  'DOOR',
  'STAIRS',
  'ELEVATOR',
  'ESCALATOR',
  'OUTDOOR_PATH',
  'SHUTTLE',
] as const

const optionalInteger = (form: FormData, name: string) => {
  const raw = String(form.get(name) ?? '').trim()
  return raw ? Number(raw) : null
}

function FloorAvailability({
  tenantId,
  venueId,
  floor,
}: {
  tenantId: string
  venueId: string
  floor: TopologyFloor
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function apply() {
    if (!reason.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.setVenueFloorAvailability.mutate({
        tenantId,
        venueId,
        floorId: floor.id,
        expectedUpdatedAt: floor.updatedAt,
        active: !floor.isActive,
        reason: reason.trim(),
      })
      setMessage(floor.isActive ? 'Floor deactivated.' : 'Floor activated for reviewed anchors.')
      setReason('')
      router.refresh()
    } catch {
      setMessage('The floor was not changed. Refresh and check its active anchors.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-pf-light pt-3">
      <label className="block text-xs font-semibold text-pf-deep/75">
        Review reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3 text-sm"
        />
      </label>
      <button
        type="button"
        onClick={() => void apply()}
        disabled={busy || !reason.trim()}
        className="mt-2 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
      >
        {busy ? 'Saving…' : floor.isActive ? 'Deactivate floor' : 'Activate floor'}
      </button>
      {message ? (
        <p className="mt-2 text-sm text-pf-deep/70" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}

function FloorEdit({
  tenantId,
  venueId,
  floor,
}: {
  tenantId: string
  venueId: string
  floor: TopologyFloor
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.updateVenueFloorDraft.mutate({
        tenantId,
        venueId,
        floorId: floor.id,
        expectedUpdatedAt: floor.updatedAt,
        stableKey: String(form.get('stableKey') ?? ''),
        name: String(form.get('name') ?? ''),
        level: optionalInteger(form, 'level'),
        sortOrder: Number(form.get('sortOrder') ?? 0),
        mapImageUrl: String(form.get('mapImageUrl') ?? '').trim() || null,
        reason: String(form.get('reason') ?? ''),
      })
      setMessage('Floor draft updated. Activation remains separate.')
      router.refresh()
    } catch {
      setMessage('The floor draft was not updated. Refresh and check its key and map URL.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-3 rounded-2xl border border-pf-light p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pf-primary">
        Edit floor draft
      </summary>
      <form onSubmit={(event) => void submit(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-pf-deep/75">
          Name
          <input
            name="name"
            required
            maxLength={160}
            defaultValue={floor.name}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Floor stable key
          <input
            name="stableKey"
            required
            maxLength={100}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            defaultValue={floor.stableKey}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Level
          <input
            name="level"
            type="number"
            min={-1000}
            max={1000}
            defaultValue={floor.level ?? ''}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="text-xs font-semibold text-pf-deep/75">
          Sort order
          <input
            name="sortOrder"
            required
            type="number"
            min={-10000}
            max={10000}
            defaultValue={floor.sortOrder}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Public HTTPS map image URL
          <input
            name="mapImageUrl"
            type="url"
            maxLength={2000}
            defaultValue={floor.mapImageUrl ?? ''}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Change reason
          <input
            name="reason"
            required
            maxLength={500}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <div className="sm:col-span-2">
          <button
            disabled={busy}
            className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Update floor draft'}
          </button>
          {message ? (
            <p className="mt-2 text-sm text-pf-deep/70" role="status">
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </details>
  )
}

function ConnectionAvailability({
  tenantId,
  venueId,
  connection,
}: {
  tenantId: string
  venueId: string
  connection: TopologyConnection
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function apply() {
    if (!reason.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.setVenueLocationConnectionAvailability.mutate({
        tenantId,
        venueId,
        connectionId: connection.id,
        expectedUpdatedAt: connection.updatedAt,
        active: !connection.isActive,
        reason: reason.trim(),
      })
      setMessage(connection.isActive ? 'Connection deactivated.' : 'Verified connection activated.')
      setReason('')
      router.refresh()
    } catch {
      setMessage('The connection was not changed. Refresh and verify both endpoint anchors.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-pf-light pt-3">
      <label className="block text-xs font-semibold text-pf-deep/75">
        Review reason
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
        />
      </label>
      <button
        type="button"
        onClick={() => void apply()}
        disabled={busy || !reason.trim()}
        className="mt-2 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
      >
        {busy
          ? 'Saving…'
          : connection.isActive
            ? 'Deactivate connection'
            : 'Activate verified connection'}
      </button>
      {message ? (
        <p className="mt-2 text-sm text-pf-deep/70" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}

function ConnectionEdit({
  tenantId,
  venueId,
  connection,
  locations,
}: {
  tenantId: string
  venueId: string
  connection: TopologyConnection
  locations: TopologyLocation[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setMessage(null)
    try {
      await client.admin.updateVenueLocationConnectionDraft.mutate({
        tenantId,
        venueId,
        connectionId: connection.id,
        expectedUpdatedAt: connection.updatedAt,
        fromLocationId: String(form.get('fromLocationId') ?? ''),
        toLocationId: String(form.get('toLocationId') ?? ''),
        kind: String(form.get('kind') ?? 'WALKWAY') as (typeof connectionKinds)[number],
        bidirectional: form.get('bidirectional') === 'on',
        accessible: form.get('accessible') === 'on',
        directions: String(form.get('directions') ?? '').trim() || null,
        reason: String(form.get('reason') ?? ''),
      })
      setMessage('Connection draft updated. Activation remains separate.')
      router.refresh()
    } catch {
      setMessage('The connection draft was not updated. Refresh and verify both anchors.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="mt-3 rounded-2xl border border-pf-light p-3">
      <summary className="cursor-pointer text-sm font-semibold text-pf-primary">
        Edit connection draft
      </summary>
      <form onSubmit={(event) => void submit(event)} className="mt-3 grid gap-3 sm:grid-cols-2">
        <AnchorSelect
          name="fromLocationId"
          label="From anchor"
          locations={locations}
          defaultValue={connection.fromLocationId}
        />
        <AnchorSelect
          name="toLocationId"
          label="To anchor"
          locations={locations}
          defaultValue={connection.toLocationId}
        />
        <KindSelect defaultValue={connection.kind} />
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-deep">
          <input name="bidirectional" type="checkbox" defaultChecked={connection.bidirectional} />{' '}
          Bidirectional
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-deep">
          <input name="accessible" type="checkbox" defaultChecked={connection.accessible} />{' '}
          Accessible route
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Directions
          <textarea
            name="directions"
            maxLength={2000}
            rows={2}
            defaultValue={connection.directions ?? ''}
            className="mt-1 w-full rounded-xl border border-pf-light p-3"
          />
        </label>
        <label className="sm:col-span-2 text-xs font-semibold text-pf-deep/75">
          Change reason
          <input
            name="reason"
            required
            maxLength={500}
            className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
          />
        </label>
        <div className="sm:col-span-2">
          <button
            disabled={busy}
            className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Update connection draft'}
          </button>
          {message ? (
            <p className="mt-2 text-sm text-pf-deep/70" role="status">
              {message}
            </p>
          ) : null}
        </div>
      </form>
    </details>
  )
}

function AnchorSelect({
  name,
  label,
  locations,
  defaultValue = '',
}: {
  name: string
  label: string
  locations: TopologyLocation[]
  defaultValue?: string
}) {
  return (
    <label className="text-sm font-semibold text-pf-deep">
      {label}
      <select
        name={name}
        required
        defaultValue={defaultValue}
        className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
      >
        <option value="" disabled>
          Select an anchor
        </option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.displayName} · {location.stableKey}
            {location.isActive ? '' : ' (inactive)'}
          </option>
        ))}
      </select>
    </label>
  )
}

function KindSelect({ defaultValue = 'WALKWAY' }: { defaultValue?: string }) {
  return (
    <label className="text-sm font-semibold text-pf-deep">
      Connection kind
      <select
        name="kind"
        defaultValue={defaultValue}
        className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
      >
        {connectionKinds.map((kind) => (
          <option key={kind} value={kind}>
            {kind.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  )
}

export function VenueLocationTopologyAuthoring({
  tenantId,
  venueId,
  floors,
  locations,
  connections,
}: {
  tenantId: string
  venueId: string
  floors: TopologyFloor[]
  locations: TopologyLocation[]
  connections: TopologyConnection[]
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [floorBusy, setFloorBusy] = useState(false)
  const [floorMessage, setFloorMessage] = useState<string | null>(null)
  const [connectionBusy, setConnectionBusy] = useState(false)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const locationName = new Map(locations.map((location) => [location.id, location.displayName]))

  async function createFloor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const element = event.currentTarget
    const form = new FormData(element)
    setFloorBusy(true)
    setFloorMessage(null)
    try {
      await client.admin.createVenueFloorDraft.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        stableKey: String(form.get('stableKey') ?? ''),
        name: String(form.get('name') ?? ''),
        level: optionalInteger(form, 'level'),
        sortOrder: Number(form.get('sortOrder') ?? 0),
        mapImageUrl: String(form.get('mapImageUrl') ?? '').trim() || null,
      })
      element.reset()
      setFloorMessage('Floor saved as an inactive review-only draft.')
      router.refresh()
    } catch {
      setFloorMessage('The floor was not saved. Check its key and public map URL.')
    } finally {
      setFloorBusy(false)
    }
  }

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const element = event.currentTarget
    const form = new FormData(element)
    setConnectionBusy(true)
    setConnectionMessage(null)
    try {
      await client.admin.createVenueLocationConnectionDraft.mutate({
        operationId: crypto.randomUUID(),
        tenantId,
        venueId,
        fromLocationId: String(form.get('fromLocationId') ?? ''),
        toLocationId: String(form.get('toLocationId') ?? ''),
        kind: String(form.get('kind') ?? 'WALKWAY') as (typeof connectionKinds)[number],
        bidirectional: form.get('bidirectional') === 'on',
        accessible: form.get('accessible') === 'on',
        directions: String(form.get('directions') ?? '').trim() || null,
      })
      element.reset()
      setConnectionMessage('Connection saved as an inactive review-only draft.')
      router.refresh()
    } catch {
      setConnectionMessage('The connection was not saved. Choose two distinct venue anchors.')
    } finally {
      setConnectionBusy(false)
    }
  }

  return (
    <section className="rounded-3xl border border-pf-light bg-pf-surface p-5 sm:p-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-pf-primary">
          Venue topology
        </p>
        <h3 className="mt-2 text-xl font-semibold text-pf-deep">Floors and verified connections</h3>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-pf-deep/75">
          Build reviewable structure around location anchors. Drafts remain inactive. This records
          trusted topology for future guidance; it does not compute routes.
        </p>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="rounded-3xl border border-pf-light bg-white p-4 sm:p-5">
          <h4 className="font-semibold text-pf-deep">Create floor draft</h4>
          <form
            onSubmit={(event) => void createFloor(event)}
            className="mt-3 grid gap-3 sm:grid-cols-2"
          >
            <label className="text-sm font-semibold text-pf-deep">
              Name
              <input
                name="name"
                required
                maxLength={160}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Floor stable key
              <input
                name="stableKey"
                required
                maxLength={100}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="ground-floor"
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Level
              <input
                name="level"
                type="number"
                min={-1000}
                max={1000}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="text-sm font-semibold text-pf-deep">
              Sort order
              <input
                name="sortOrder"
                required
                type="number"
                min={-10000}
                max={10000}
                defaultValue={0}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <label className="sm:col-span-2 text-sm font-semibold text-pf-deep">
              Public HTTPS map image URL
              <input
                name="mapImageUrl"
                type="url"
                maxLength={2000}
                className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
              />
            </label>
            <div className="sm:col-span-2">
              <button
                disabled={floorBusy}
                className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {floorBusy ? 'Saving…' : 'Save floor draft'}
              </button>
              {floorMessage ? (
                <p className="mt-2 text-sm text-pf-deep/70" role="status">
                  {floorMessage}
                </p>
              ) : null}
            </div>
          </form>
        </div>
        <div className="rounded-3xl border border-pf-light bg-white p-4 sm:p-5">
          <h4 className="font-semibold text-pf-deep">Create connection draft</h4>
          {locations.length >= 2 ? (
            <form
              onSubmit={(event) => void createConnection(event)}
              className="mt-3 grid gap-3 sm:grid-cols-2"
            >
              <AnchorSelect name="fromLocationId" label="From anchor" locations={locations} />
              <AnchorSelect name="toLocationId" label="To anchor" locations={locations} />
              <KindSelect />
              <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-deep">
                <input name="bidirectional" type="checkbox" defaultChecked /> Bidirectional
              </label>
              <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-deep">
                <input name="accessible" type="checkbox" /> Accessible route
              </label>
              <label className="sm:col-span-2 text-sm font-semibold text-pf-deep">
                Directions
                <textarea
                  name="directions"
                  maxLength={2000}
                  rows={2}
                  className="mt-1 w-full rounded-xl border border-pf-light p-3"
                />
              </label>
              <div className="sm:col-span-2">
                <button
                  disabled={connectionBusy}
                  className="min-h-11 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {connectionBusy ? 'Saving…' : 'Save connection draft'}
                </button>
                {connectionMessage ? (
                  <p className="mt-2 text-sm text-pf-deep/70" role="status">
                    {connectionMessage}
                  </p>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-4 text-sm text-pf-deep/70">
              Create at least two anchors before defining a connection.
            </p>
          )}
        </div>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div>
          <h4 className="font-semibold text-pf-deep">Floors</h4>
          {floors.length ? (
            <div className="mt-3 space-y-3">
              {floors.map((floor) => (
                <article key={floor.id} className="rounded-2xl border border-pf-light bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-pf-deep">{floor.name}</p>
                      <p className="mt-1 text-xs text-pf-deep/60">
                        {floor.stableKey} · level {floor.level ?? 'not set'}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-bold ${floor.isActive ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}
                    >
                      {floor.isActive ? 'Active' : 'Review only'}
                    </span>
                  </div>
                  {!floor.isActive ? (
                    <FloorEdit tenantId={tenantId} venueId={venueId} floor={floor} />
                  ) : null}
                  <FloorAvailability tenantId={tenantId} venueId={venueId} floor={floor} />
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-4 text-sm text-pf-deep/70">
              No floors yet. A venue without floors can still use standalone anchors.
            </p>
          )}
        </div>
        <div>
          <h4 className="font-semibold text-pf-deep">Connections</h4>
          {connections.length ? (
            <div className="mt-3 space-y-3">
              {connections.map((connection) => (
                <article
                  key={connection.id}
                  className="rounded-2xl border border-pf-light bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-pf-deep">
                        {locationName.get(connection.fromLocationId) ?? 'Unknown anchor'} →{' '}
                        {locationName.get(connection.toLocationId) ?? 'Unknown anchor'}
                      </p>
                      <p className="mt-1 text-xs text-pf-deep/60">
                        {connection.kind.replaceAll('_', ' ')} ·{' '}
                        {connection.bidirectional ? 'two way' : 'one way'} ·{' '}
                        {connection.accessible ? 'accessible' : 'not marked accessible'}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-bold ${connection.isActive ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-950'}`}
                    >
                      {connection.isActive ? 'Active' : 'Review only'}
                    </span>
                  </div>
                  {connection.directions ? (
                    <p className="mt-2 text-sm text-pf-deep/75">{connection.directions}</p>
                  ) : null}
                  {!connection.isActive ? (
                    <ConnectionEdit
                      tenantId={tenantId}
                      venueId={venueId}
                      connection={connection}
                      locations={locations}
                    />
                  ) : null}
                  <ConnectionAvailability
                    tenantId={tenantId}
                    venueId={venueId}
                    connection={connection}
                  />
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-3 rounded-2xl border border-dashed border-pf-light p-4 text-sm text-pf-deep/70">
              No verified connections yet. Nothing here implies route computation.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
