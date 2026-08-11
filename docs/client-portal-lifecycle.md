# Client portal lifecycle read model

The client portal lifecycle is derived at read time. It is not a mutable database status and does
not replace the lifecycle of intake, media, venue packages, venues, or offboarding plans.

`portal.getVenueLifecycles` reads only tenant-scoped, explicitly selected evidence:

- active public Place and Knowledge counts plus current venue availability;
- media intake collection, processing, and review-ready status counts;
- structured intake proposals awaiting review;
- Venue Package status counts;
- prior active venue history for a truthful paused state;
- active offboarding plan targets.

The resolver's precedence is offboarding, paused, revisions, live, ready, client preview, internal
review, processing, collecting, then setup requested. A new venue's default `isActive` value alone
does not make it live; it also needs public content. A paused state requires prior-active evidence
and evidence the venue had publishable content. The API does not return raw intake, package,
history, or offboarding records to the client.

The browser-safe contract supplies human labels, summaries, and one bounded client action. UI copy
does not expose package, worker, queue, analytics, or agent terminology. Single-venue accounts do
not render a venue selector; multi-venue accounts resolve lifecycle independently and switch via
the existing `?venue=` scope.
