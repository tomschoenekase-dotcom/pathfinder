# Partner Read API v1 foundation

Status: dark, default-off contract and adapter foundation. It is not a public API launch.

The browser-safe catalog and validation contracts live in
`packages/contracts/src/partner-read-api.ts`. The server-only registry lives in
`packages/api/src/partner-api/registry.ts`.

The registry is available only when the existing `partnerReadApi` feature flag resolves from the
exact value `PARTNER_READ_API_ENABLED=true`. No new environment variable or deployed configuration
is introduced here.

## Read surface

- client account
- client venues
- approved visitor-facing venue content
- partner-safe venue configuration
- partner-safe readiness
- partner-visible operational updates

Every v1 operation is explicitly client- or venue-scoped, capability-gated, read-only, low risk,
and non-public. Inputs never accept `tenantId`. Pagination is bounded to 100 records per read.

The server adapter requires an already authenticated, prevalidated credential context. Each call
also invokes mandatory injected dependencies that recheck current credential revocation/expiry
state, enforce rate limits, and write tenant-bound audit events. Scope is checked before a domain
read. Underlying implementations must call existing canonical authorized read services; the
adapter must not reproduce router business logic or query Prisma directly.

## Deliberate limitations

- No HTTP route, listener, controller, OpenAPI publication, CORS policy, or public hostname exists.
- No API-key creation, hashing, storage, rotation, revocation persistence, authentication, or live
  credential exists.
- No database, Prisma schema, migration, environment configuration, dashboard, web, or SDK change
  is included. The database incident stop remains active.
- No production domain actions or audit/rate-limit implementations are bound yet.
- A production transport still requires authorization integration, response-field review, cache
  policy, observability, deployed rate limits, adversarial staging tests, and owner approval before
  launch.
