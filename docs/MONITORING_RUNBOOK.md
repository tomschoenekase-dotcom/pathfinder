# Errors-only monitoring runbook

PathFinder has an optional Sentry error boundary for the public web app, the
operator dashboard, and background workers. It is **disabled by default** and
does not establish production readiness by itself.

## Data boundary

The integration sends errors only. Tracing, profiling, session replay, SDK
logs, breadcrumbs, local variables, default PII, client outcome reports, and
SDK metrics are disabled. A shared `beforeSend` boundary removes request data,
users, transactions, breadcrumbs,
arbitrary contexts/extra fields, code context, absolute paths, and original
message text. Only bounded service/environment/release/action tags and stack
frame locations remain.

Do not add tenant, venue, user, session, job, storage, prompt, response, or
provider content to monitoring tags or scope. Application JSON logs remain the
authoritative bounded local record: the shared logger retains safe operational
identifiers, codes, counts, and states, but centrally redacts credentials,
content fields, free-form strings, stacks, and nested error objects before
writing stdout or forwarding a handled error to monitoring. Callers must still
avoid logging content; the central boundary is last-line containment, not
permission to collect it.

## Runtime enablement

Server and worker monitoring requires both:

- `SENTRY_ENABLED=true`
- `SENTRY_DSN=<reviewed project DSN>`

Browser monitoring is a separate opt-in and requires both:

- `NEXT_PUBLIC_SENTRY_ENABLED=true`
- `NEXT_PUBLIC_SENTRY_DSN=<reviewed public DSN>`

`SENTRY_RELEASE` should be the immutable deploy commit. If omitted, the runtime
uses the Railway, Vercel, or GitHub commit SHA, then `unknown`. The environment
is derived from `RAILWAY_ENVIRONMENT`, then `NODE_ENV`. Next config stamps the
same safe values into `NEXT_PUBLIC_SENTRY_RELEASE` and
`NEXT_PUBLIC_SENTRY_ENVIRONMENT`; they contain no credentials or private data.

The workers preload `dist/sentry.js` from both the package start command and
the container command so startup/module failures are observable. Removing
either preload is a release regression.

## Source maps

Source-map upload is intentionally not wired to the build yet. It requires a
specific staging Sentry organization/project, a build-only auth token, explicit
third-party retention approval, and proof that maps are absent from public
artifacts after upload. Never expose `SENTRY_AUTH_TOKEN` through a
`NEXT_PUBLIC_` variable. `SENTRY_SOURCE_MAPS_ENABLED` remains false until that
separate gate is implemented and reviewed.

## Staging canary gate

Before enabling any production runtime:

1. Create/approve isolated staging projects and retention/access policy.
2. Enable one staging service at a time with synthetic data only.
3. Emit a controlled synthetic exception with a unique action tag.
4. Confirm exactly one event, correct service/environment/release grouping,
   and no request, identity, content, breadcrumb, or arbitrary context fields.
5. Configure and test an alert route; record delivery evidence separately.
6. Disable the synthetic path and record the project IDs and alert ownership.

Local tests prove configuration and sanitization, not external ingest, alert
delivery, retention, grouping, or source-map association.

## Rollback

Set both enable flags to `false` and redeploy. The SDK remains loaded but has no
destination and the application continues using local JSON logs. If the SDK
itself fails while reporting a handled log error, the logger swallows that
monitoring failure and preserves the original application path.
