'use client'

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'

import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { useTRPCClient } from '../lib/trpc'
import {
  PortalNotice,
  PortalSection,
  portalButtonPrimary,
  portalButtonSecondary,
  portalInput,
} from './portal/PortalPrimitives'

type Venue = { id: string; name: string }
type Priority = 'LOW' | 'NORMAL' | 'HIGH'
type Category = 'cold_drink' | 'hot_drink' | 'snack' | 'meal' | 'other'

type Overview = {
  policy: {
    version: number
    enabled: boolean
    maxBoost: number
    maxUnsolicitedPerSession: number
    expiresAt: Date | string | null
    ownerLabel: string
  } | null
  items: Array<{
    id: string
    version: number
    stableKey: string
    name: string
    category: string
    priceMinor: number | null
    currency: string | null
    availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN'
    lastVerifiedAt: Date | string | null
    archivedAt: Date | string | null
    commercialPriority: Priority
  }>
}

type Measurement = {
  windowDays: number
  truncated: boolean
  counts: Record<string, number>
  note: string
  clickDefinition: string
}

function message(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Please try again.'
}

function money(item: Overview['items'][number]) {
  return item.priceMinor === null
    ? 'no price'
    : `${(item.priceMinor / 100).toFixed(2)} ${item.currency ?? ''}`.trim()
}

const COUNT_LABELS: Array<[string, string]> = [
  ['eligibleSessions', 'Sessions with an eligible item'],
  ['shownSessions', 'Sessions where an item was shown'],
  ['shownEvents', 'Times an item was shown'],
  ['declinedSessions', 'Sessions that declined suggestions'],
  ['shownSessionsWithClick', 'Shown sessions with a click on the item place'],
  ['candidateNotShownSessions', 'Eligible sessions with nothing shown'],
  ['candidateNotShownSessionsWithClick', 'Those sessions with a click on an item place'],
]

/**
 * Manager-only controls for the venue-recommendation capability. Role checks here are cosmetic;
 * every procedure enforces MANAGER or stricter on the server.
 */
export function VenueRecommendationsPanel({
  venues,
  initialVenueId,
  canManage,
}: {
  venues: Venue[]
  initialVenueId: string
  canManage: boolean
}) {
  const client = useTRPCClient()
  const [venueId, setVenueId] = useState(initialVenueId)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [measurement, setMeasurement] = useState<Measurement | null>(null)
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const scope = useRef(new AbortController())

  const [enabled, setEnabled] = useState(false)
  const [maxBoost, setMaxBoost] = useState(3)
  const [cap, setCap] = useState(1)
  const [expires, setExpires] = useState('')
  const [owner, setOwner] = useState('')

  const [stableKey, setStableKey] = useState('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState<Category>('cold_drink')
  const [price, setPrice] = useState('')
  const [available, setAvailable] = useState(true)
  const [allergens, setAllergens] = useState('')
  const [claims, setClaims] = useState('')

  const load = useCallback(
    async (parentSignal: AbortSignal) => {
      if (!canManage) return
      try {
        const [next, counts] = await Promise.all([
          runBoundedClientRequest({
            parentSignal,
            timeoutMs: 15_000,
            request: (signal) =>
              client.venueRecommendation.getOverview.query({ venueId }, { signal }),
          }),
          runBoundedClientRequest({
            parentSignal,
            timeoutMs: 15_000,
            request: (signal) =>
              client.venueRecommendation.getMeasurement.query({ venueId, days: 30 }, { signal }),
          }),
        ])
        if (parentSignal.aborted) return
        setOverview(next as unknown as Overview)
        setMeasurement(counts as unknown as Measurement)
        const policy = next.policy
        setEnabled(policy?.enabled ?? false)
        setMaxBoost(policy?.maxBoost ?? 3)
        setCap(policy?.maxUnsolicitedPerSession ?? 1)
        setOwner(policy?.ownerLabel ?? '')
        setExpires(policy?.expiresAt ? new Date(policy.expiresAt).toISOString().slice(0, 10) : '')
      } catch (error) {
        if (parentSignal.aborted) return
        setStatus({ tone: 'error', text: message(error) })
      }
    },
    [client, venueId, canManage],
  )

  useEffect(() => {
    const controller = new AbortController()
    scope.current = controller
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true)
    setStatus(null)
    try {
      await action()
      setStatus({ tone: 'success', text: done })
      await load(scope.current.signal)
    } catch (error) {
      setStatus({ tone: 'error', text: message(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!canManage) {
    return (
      <PortalSection
        id="venue-recommendations"
        title="Featured items"
        description="Managers and owners can set up featured items for this guide."
      />
    )
  }

  function savePolicy(event: FormEvent) {
    event.preventDefault()
    void run(
      () =>
        client.venueRecommendation.upsertPolicy.mutate({
          venueId,
          ...(overview?.policy ? { expectedVersion: overview.policy.version } : {}),
          enabled,
          maxBoost,
          maxUnsolicitedPerSession: cap,
          expiresAt: expires ? new Date(`${expires}T23:59:59.000Z`) : null,
          ownerLabel: owner.trim() || 'Venue manager',
        }),
      'Policy saved.',
    )
  }

  function addItem(event: FormEvent) {
    event.preventDefault()
    const now = new Date()
    const minor = price.trim() === '' ? null : Math.round(Number(price) * 100)
    const allergenList = allergens
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    void run(
      () =>
        client.venueRecommendation.upsertItem.mutate({
          venueId,
          stableKey,
          fields: {
            category,
            name,
            priceMinor: minor,
            currency: minor === null ? null : 'USD',
            priceObservedAt: minor === null ? null : now,
            availability: available ? 'AVAILABLE' : 'UNAVAILABLE',
            availabilityObservedAt: now,
            // Blank means "not verified", which is never treated as "no allergens".
            allergens:
              allergens.trim() === ''
                ? { status: 'unknown', values: [] }
                : {
                    status: 'known',
                    values: allergenList.filter((v) => v.toLowerCase() !== 'none'),
                  },
            lastVerifiedAt: now,
            allowedClaims: claims
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
          },
        }),
      'Item saved.',
    )
  }

  return (
    <PortalSection
      id="venue-recommendations"
      title="Featured items"
      description="Let the guide mention one item a little more often, only when it genuinely fits what a guest asks. Guests see a 'Featured by' line whenever it does."
    >
      <div className="mt-4 space-y-6">
        {venues.length > 1 ? (
          <label className="block text-sm font-semibold">
            Venue
            <select
              className={`${portalInput} mt-1`}
              value={venueId}
              onChange={(event) => setVenueId(event.target.value)}
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {status ? (
          <PortalNotice tone={status.tone} role={status.tone === 'error' ? 'alert' : 'status'}>
            {status.text}
          </PortalNotice>
        ) : null}

        <form onSubmit={savePolicy} className="space-y-3" aria-label="Recommendation policy">
          <h3 className="font-semibold">
            Policy {overview?.policy ? `(version ${overview.policy.version})` : '(not set up: off)'}
          </h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Turn featured items on for this venue
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              Tie-break strength (0 to 10)
              <input
                className={`${portalInput} mt-1`}
                type="number"
                min={0}
                max={10}
                value={maxBoost}
                onChange={(e) => setMaxBoost(Number(e.target.value))}
              />
            </label>
            <label className="text-sm font-semibold">
              Unprompted mentions per guest session (proposed test setting: 1)
              <input
                className={`${portalInput} mt-1`}
                type="number"
                min={1}
                max={3}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
            </label>
            <label className="text-sm font-semibold">
              Expires on
              <input
                className={`${portalInput} mt-1`}
                type="date"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
              />
            </label>
            <label className="text-sm font-semibold">
              Owner
              <input
                className={`${portalInput} mt-1`}
                value={owner}
                maxLength={200}
                onChange={(e) => setOwner(e.target.value)}
              />
            </label>
          </div>
          <button className={portalButtonPrimary} disabled={busy} type="submit">
            Save policy
          </button>
        </form>

        <div>
          <h3 className="font-semibold">Items</h3>
          {overview?.items.length ? (
            <ul className="mt-2 divide-y divide-tk-rule text-sm">
              {overview.items
                .filter((item) => !item.archivedAt)
                .map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <strong>{item.name}</strong> · {money(item)} ·{' '}
                      {item.availability.toLowerCase()}
                      {item.lastVerifiedAt ? '' : ' · not verified'}
                    </span>
                    <label className="flex items-center gap-2">
                      <span className="text-tk-soft">Private priority</span>
                      <select
                        className={portalInput}
                        value={item.commercialPriority}
                        disabled={busy}
                        onChange={(e) =>
                          void run(
                            () =>
                              client.venueRecommendation.setItemPriority.mutate({
                                venueId,
                                itemId: item.id,
                                priority: e.target.value as Priority,
                              }),
                            'Priority saved. Guests never see it.',
                          )
                        }
                      >
                        <option value="LOW">Low</option>
                        <option value="NORMAL">Normal</option>
                        <option value="HIGH">High</option>
                      </select>
                    </label>
                    <button
                      className={portalButtonSecondary}
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        void run(
                          () =>
                            client.venueRecommendation.archiveItem.mutate({
                              venueId,
                              itemId: item.id,
                              expectedVersion: item.version,
                            }),
                          'Item archived.',
                        )
                      }
                    >
                      Archive
                    </button>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-tk-soft">No items yet.</p>
          )}
        </div>

        <form onSubmit={addItem} className="space-y-3" aria-label="Add item">
          <h3 className="font-semibold">Add an item</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-semibold">
              Name
              <input
                className={`${portalInput} mt-1`}
                required
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="text-sm font-semibold">
              Stable ID (letters, numbers, dashes)
              <input
                className={`${portalInput} mt-1`}
                required
                pattern="[a-z0-9]+([-_][a-z0-9]+)*"
                value={stableKey}
                onChange={(e) => setStableKey(e.target.value)}
              />
            </label>
            <label className="text-sm font-semibold">
              Type
              <select
                className={`${portalInput} mt-1`}
                value={category}
                onChange={(e) => setCategory(e.target.value as Category)}
              >
                <option value="cold_drink">Cold drink</option>
                <option value="hot_drink">Hot drink</option>
                <option value="snack">Snack</option>
                <option value="meal">Meal</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="text-sm font-semibold">
              Price (USD)
              <input
                className={`${portalInput} mt-1`}
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="text-sm font-semibold sm:col-span-2">
              Allergens (comma separated, or write &quot;none&quot; if verified free of allergens;
              leave blank if unknown)
              <input
                className={`${portalInput} mt-1`}
                value={allergens}
                onChange={(e) => setAllergens(e.target.value)}
              />
            </label>
            <label className="text-sm font-semibold sm:col-span-2">
              Claims you can stand behind (one per line; the guide makes no other claims)
              <textarea
                className={`${portalInput} mt-1 py-2`}
                rows={2}
                value={claims}
                onChange={(e) => setClaims(e.target.value)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
            />
            In stock right now (price and stock are stamped as verified now)
          </label>
          <button className={portalButtonPrimary} disabled={busy} type="submit">
            Save item
          </button>
        </form>

        <div>
          <h3 className="font-semibold">
            Did it help? (last {measurement?.windowDays ?? 30} days)
          </h3>
          {measurement ? (
            <>
              <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {COUNT_LABELS.map(([key, label]) => (
                  <div
                    key={key}
                    className="flex justify-between gap-3 border-b border-tk-rule py-1"
                  >
                    <dt>{label}</dt>
                    <dd className="font-semibold">{measurement.counts[key] ?? 0}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-sm text-tk-soft">{measurement.note}</p>
              <p className="mt-1 text-xs text-tk-soft">{measurement.clickDefinition}</p>
              {measurement.truncated ? (
                <p className="mt-1 text-xs text-tk-soft">Counts are capped for this window.</p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-sm text-tk-soft">Loading counts.</p>
          )}
        </div>
      </div>
    </PortalSection>
  )
}
