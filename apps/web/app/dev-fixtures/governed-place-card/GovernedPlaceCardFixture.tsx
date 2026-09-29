'use client'

import type { CSSProperties } from 'react'
import { ResponseRenderer } from '../../../components/ResponseRenderer'

const image = {
  id: 'east-gallery',
  name: 'East Gallery',
  type: 'EXHIBIT',
  photoUrl: '/dev-fixtures/governed-place-card-photo.svg',
  photoAttribution: {
    altText: 'Warm daylight across the East Gallery entrance',
    caption: 'East Gallery entrance after the 2026 renovation',
    sourceName: 'Museum archive',
    sourceUrl: null,
  },
  shortDescription: 'The ceramics exhibition begins beyond the carved oak doors.',
  areaName: 'First floor · East wing',
  hours: 'Open until 5 PM',
  lat: null,
  lng: null,
}

const location = {
  ...image,
  id: 'garden',
  name: 'Garden',
  photoUrl: null,
  photoAttribution: null,
  lat: 40.7,
  lng: -74,
}

export function GovernedPlaceCardFixture() {
  return (
    <main
      className="min-h-screen bg-[#f4f7f5] px-4 py-10 sm:px-8"
      style={
        {
          '--chat-border': '#cbd5d1',
          '--chat-card': '#fff',
          '--chat-bg': '#eef4f1',
          '--chat-text': '#173d34',
          '--chat-text-muted': '#526d65',
          '--chat-accent': '#c96f46',
          '--chat-accent-text': '#173d34',
        } as CSSProperties
      }
    >
      <div className="mx-auto max-w-2xl space-y-8">
        <section>
          <h1 className="mb-4 text-lg font-semibold text-[#173d34]">Non-location · image</h1>
          <ResponseRenderer content="Visit East Gallery." places={[image]} locationAware={false} />
        </section>
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[#173d34]">Location · directions</h2>
          <ResponseRenderer content="Visit Garden." places={[location]} locationAware />
        </section>
        <section>
          <h2 className="mb-4 text-lg font-semibold text-[#173d34]">Non-location · answer only</h2>
          <ResponseRenderer content="Visit Garden." places={[location]} locationAware={false} />
        </section>
      </div>
    </main>
  )
}
