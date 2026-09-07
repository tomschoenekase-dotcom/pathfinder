'use client'

import type { CSSProperties } from 'react'
import { PlaceCard } from '../../../components/PlaceCard'

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
      <section className="mx-auto max-w-md">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#8b4b30]">
          Reviewed place reference
        </p>
        <h1 className="mb-5 mt-1 text-2xl font-semibold text-[#173d34]">
          A grounded visual, with its source
        </h1>
        <PlaceCard
          id="east-gallery"
          name="East Gallery"
          type="EXHIBIT"
          photoUrl="/dev-fixtures/governed-place-card-photo.svg"
          photoAttribution={{
            altText: 'Warm daylight across the East Gallery entrance',
            caption: 'East Gallery entrance after the 2026 renovation',
            sourceName: 'Museum archive',
            sourceUrl: null,
          }}
          shortDescription="The ceramics exhibition begins beyond the carved oak doors."
          areaName="First floor · East wing"
          hours="Open until 5 PM"
          distanceMeters={86}
          lat={null}
          lng={null}
        />
        <p className="mt-4 text-sm leading-6 text-[#526d65]">
          Source links are off for this guide. The required credit remains readable without becoming
          a clickable external link.
        </p>
      </section>
    </main>
  )
}
