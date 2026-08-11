# Packet 2 performance slice — 2026-08-11

## Analytics place-interest fan-out

The former tenant analytics page waited for its initial data (including the venue list), then issued
one `analytics.getPlaceInterest` call per venue. Each call performed two database reads. For `V`
venues the place-interest portion therefore cost `V` API calls, `2V` database reads, and one
additional server-render waterfall.

The reusable server-only `loadPlaceInterestOverview` helper performs one tenant-scoped aggregate
read and, when results exist, one tenant-scoped place-name read. It returns at most 25 places per
venue. An authorized internal consumer can therefore replace the fan-out with one helper invocation
and at most two database reads regardless of venue count. Tests pin tenant filters, aggregation,
ranking, and the per-venue response bound.

The external client portal intentionally exposes no analytics. Its compatibility `/analytics`
route now redirects to `/` before creating a caller or reading data, and a route test pins that
boundary. The helper is not mounted on the client-facing tRPC router and is retained only as an
internal server primitive.

This is code-level evidence rather than a live latency benchmark. The database incident stop
prohibits external database inspection, so no live environment or production dataset was used.
