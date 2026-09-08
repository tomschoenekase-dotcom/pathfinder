'use client'

import { useState, type CSSProperties } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import {
  LocationRoutePlanner,
  type LocationRoutePlannerDataSource,
} from '../../../components/LocationRoutePlanner'
import { TRPCProvider } from '../../../lib/trpc'

const locations = [
  { id: 'entry', stableKey: 'entry', kind: 'ENTRANCE', displayName: 'Main entrance', floor: null },
  {
    id: 'gallery',
    stableKey: 'gallery',
    kind: 'EXHIBIT',
    displayName: 'Lake ecology gallery',
    floor: null,
  },
  {
    id: 'restroom',
    stableKey: 'restroom',
    kind: 'RESTROOM',
    displayName: 'Garden restrooms',
    floor: null,
  },
]
const source: LocationRoutePlannerDataSource = {
  catalog: async () => ({ locations }),
  reachableDestination: async (input) => ({
    destination: {
      ...locations[2]!,
      media: {
        photoUrl: '/api/venue-media/fixture-route-photo?venue=fixture-garden',
        photoAttribution: {
          altText: 'Synthetic diagram of the garden restroom entrance',
          caption: 'Fixture image for the reviewed destination',
          sourceName: 'Garden Museum fixture',
          sourceUrl: null,
        },
      },
    },
    ranking: {
      basis: 'STRAIGHT_LINE_AMONG_REACHABLE',
      straightLineMeters: 85,
      reachableOptionCount: 1,
      reviewedSegmentCount: 1,
      walkingDistanceMeters: null,
      walkingMinutes: null,
      alreadyHere: input.fromLocationId === 'restroom',
    },
  }),
  route: async (input) => {
    const from = locations.find((location) => location.id === input.fromLocationId)!
    const to = locations.find((location) => location.id === input.toLocationId)!
    return {
      from,
      to,
      accessibleOnly: input.accessibleOnly,
      segmentCount: 1,
      describedSegmentCount: 1,
      guidanceConfidence: 'HIGH',
      hasEquivalentRoute: false,
      review: { status: 'VENUE_REVIEWED', reviewedAt: new Date('2026-09-07T00:00:00Z') },
      segments: [
        {
          connectionId: 'walkway',
          kind: 'WALKWAY',
          accessible: true,
          directions: 'Follow the garden walkway to the restrooms beside the courtyard.',
          from,
          to,
        },
      ],
    }
  },
}

export function ReachableRouteFixture() {
  const [language, setLanguage] = useState<SupportedChatLanguage>('English')
  return (
    <main
      className="mx-auto min-h-screen max-w-xl px-4 py-8"
      style={
        {
          '--chat-border': '#cbd5d1',
          '--chat-card': '#ffffff',
          '--chat-text': '#163a31',
          '--chat-text-muted': '#49645c',
          '--chat-surface': '#f4f7f5',
          '--chat-accent': '#23594b',
          '--chat-accent-contrast': '#ffffff',
        } as CSSProperties
      }
    >
      <h1 className="mb-4 text-xl font-semibold">Garden visitor guide</h1>
      <label className="mb-5 block">
        Fixture language
        <select
          className="ms-2 min-h-11 border px-2"
          value={language}
          onChange={(event) => setLanguage(event.target.value as SupportedChatLanguage)}
        >
          <option value="English">English</option>
          <option value="العربية">العربية</option>
          <option value="Français">Français</option>
        </select>
      </label>
      <TRPCProvider scopeKey="reachable-route-fixture">
        <LocationRoutePlanner
          venueId="fixture-venue"
          anonymousToken="123e4567-e89b-42d3-a456-426614174000"
          language={language}
          dataSource={source}
        />
      </TRPCProvider>
    </main>
  )
}
