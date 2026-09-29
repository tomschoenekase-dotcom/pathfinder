# Packet 14 local distribution preflight

Read-only source review at R1.1 `512df5d4329ac4842b1c5e3cb9ea6cd92710d324`; no services or databases were started during this review and no `.env` files were read. The separate Packet 14 local run later started only the nC disposable stack and passed the direct visitor chat, appearance persistence, and tenant isolation journeys. This preflight records route prerequisites; the execution evidence is in `qa/packet-14-m5-evidence-checklist.md`.

2026-09-28 runtime addendum: after this source review, the nC disposable stack ran all 252 migrations and the synthetic seed. One combined browser invocation passed the three R1.1 journeys (admin skipped pending R2). The host network proof denied a synthetic non-loopback request before socket creation; the proxy's raw container egress boundary remains partial. The exact R2 framed portal route and three-run gate have not been exercised.

Each synthetic venue also has a deterministic QR SVG in the lane-owned `data/venue-qrs` directory, generated from its canonical local `/{slug}/chat?source=qr` URL and read back byte for byte by the seed. These local QR artifacts do not make the product QR-kit route available: that route still requires a current release and an HTTPS launch asset.

## Current M4 preview needs

The Packet 14 seed at `packages/db/prisma/local-full-stack-seed.ts` creates three invented, active-by-default venues and public knowledge entries:

| Tenant             | Venue ID                    | Slug                       |
| ------------------ | --------------------------- | -------------------------- |
| `org_LocalTenantA` | `cpacket14aurora0000000000` | `aurora-science-museum`    |
| `org_LocalTenantA` | `cpacket14pocket0000000000` | `pocket-collection-museum` |
| `org_LocalTenantB` | `cpacket14riverbend0000000` | `riverbend-nature-centre`  |

For the M4 visitor chat, the direct `/{venueSlug}/chat` route loads the public venue by slug and requires `isActive`; it does not resolve `VenueDistribution`. The existing seed supplies the synthetic guide content. Keep the launcher’s loopback `NEXT_PUBLIC_WEB_URL=http://127.0.0.1:56345`, development mode, and local fixture identity. `WEBSITE_DISTRIBUTION_ENABLED`, `APP_DISTRIBUTION_ENABLED`, and `EMBED_PREVIEW_ENABLED` can remain unset/false.

The R1.1 M4 Look & feel test saves the fixture appearance, then opens `/appearance-preview` in a popup. `appearancePreviewAllowed` admits this route in `NODE_ENV=development` unless `RAILWAY_ENVIRONMENT=production`; the local launcher strips hosted environment variables. The route uses the real visitor shell with an inert sample conversation. It does not require a `VenueDistribution` row, product entitlement, Stripe setting, or `DASHBOARD_URL`. Keep `TORCHIKO_VISUAL_FIXTURES_ENABLED=1` and the guarded development fixture-auth environment supplied by the local launcher. Recheck the integrated R2 framed preview before extending this claim.

## Optional `/embed` and app-webview paths

These are separate from the M4 direct chat and appearance preview. In `packages/db/src/helpers/venue-distribution.ts`, `/embed/{slug}` is website distribution and `/embed/{slug}?chrome=hidden` is app-webview. Each requires all of the following:

1. The venue is active.
2. Its `venue_distributions` row has the requested surface state `ENABLED` (schema default is `DISABLED`).
3. The matching product capability is enabled: `widget` for website or `app-webview` for app. With billing enforcement off, the resolver checks a venue override, tenant override, then the tenant plan capability; an absent plan row is denied. The local seed currently creates none of those rows.
4. Its kill switch is on: `WEBSITE_DISTRIBUTION_ENABLED=true` or `APP_DISTRIBUTION_ENABLED=true`. Legacy `EMBED_PREVIEW_ENABLED=true` opts both surfaces in and is broader; it is unnecessary for M4 and should remain off.

Website framing adds another gate: an active `venue_website_origins` row with a valid HTTPS origin. HTTP loopback is rejected by the origin normalizer. Directly opening an authorized embed route does not prove it can be framed from the dashboard.

If a future lane explicitly needs these optional surfaces, use only tenant/venue scoped synthetic entitlement rows and synthetic origins on the local disposable database, keep billing enforcement/recovery and Stripe flags false, and remove them through the lane's normal reset. Do not turn on the global legacy preview flag as a shortcut. This extra fixture state is not needed for the present M4 paths.

## QR kit limitation

`apps/dashboard/app/(app)/venues/[venueId]/qr-kit/page.tsx` displays a QR only for `READY`, `LIVE`, or `REVISIONS` lifecycle and a non-null launch asset. `portal.getVenueLaunchAsset` calls `resolveVenueLaunchSource`, which requires an active venue, globally unique slug, public content or a usable nonempty native release, and an HTTPS public URL. The launcher’s HTTP loopback `NEXT_PUBLIC_WEB_URL` cannot produce that asset: the source resolver does not pass the development loopback allowance and fails closed unless the generated public URL starts with `https://`. Enabling distribution flags or adding a `venue_distributions` row will not fix QR generation. The current seed does not prepare the lifecycle/release state for this route, and QR kit is not part of M4.

## R2-dependent unknowns

- The pinned R1.1 M4 preview is a popup of `/appearance-preview`; it is not proof of the separate client portal redesign's framed live preview. That portal handoff describes an iframe-based renderer and says the web service needs a `DASHBOARD_URL` setting for framing. Confirm the exact route, frame policy, and required setting against the integrated Packet 12 R2 SHA before adding local fixture state or flags.
- Packet 7 Good fit/admin surfaces are already explicitly skipped by M4 until Packet 12 R2. Their exact venue distribution or entitlement needs are unknown until that route exists in the pinned tree.
- Do not infer that activating `/embed` or QR distribution is required to prove M4 chat, tenant isolation, or the popup appearance preview. No distribution mutation, third-party origin, or hosted flag change is authorized by this preflight.
