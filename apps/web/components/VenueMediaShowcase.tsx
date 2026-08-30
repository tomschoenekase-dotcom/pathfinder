import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import { selectVenueMediaForPresentation } from '../lib/venue-media-presentation'

export function VenueMediaShowcase({
  venueName,
  items,
}: {
  venueName: string
  items: PublicVenueMediaItem[]
}) {
  const selected = selectVenueMediaForPresentation(items)
  if (selected.length === 0) return null

  const [primary, ...supporting] = selected

  return (
    <section aria-label={`${venueName} venue media`} className="min-w-0">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-pf-deep/55">
        A look inside
      </p>
      <figure className="overflow-hidden rounded-[1.5rem] bg-pf-light/40">
        {/* Controlled WebP derivatives are already resized; bypassing Next optimization avoids a second transform. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={primary!.deliveryPath}
          alt={primary!.altText}
          width={primary!.width}
          height={primary!.height}
          decoding="async"
          fetchPriority="high"
          className="aspect-[4/3] h-auto w-full object-cover sm:aspect-[3/2]"
        />
        {primary!.caption ? (
          <figcaption className="border-t border-pf-light bg-pf-white px-4 py-3 text-sm leading-5 text-pf-deep/70">
            {primary!.caption}
          </figcaption>
        ) : null}
      </figure>

      {supporting.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {supporting.map((item) => (
            <figure
              key={item.derivativeId}
              className="min-w-0 overflow-hidden rounded-2xl bg-pf-light/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.deliveryPath}
                alt={item.altText}
                width={item.width}
                height={item.height}
                loading="lazy"
                decoding="async"
                className="aspect-[4/3] h-auto w-full object-cover"
              />
              {item.caption ? (
                <figcaption className="border-t border-pf-light bg-pf-white px-3 py-2 text-xs leading-4 text-pf-deep/70">
                  {item.caption}
                </figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-5 text-pf-deep/50">Media approved for this venue.</p>
    </section>
  )
}
