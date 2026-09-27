# Torchiko distribution proof harness

This is a task-local test harness. Its static host uses synthetic content and binds only to loopback addresses. The HTTP stub suite uses a deterministic local route/policy mock; the A5 real-stack suite uses two distinct loopback HTTPS origins and the guarded disposable Postgres database. Neither suite loads hosted/customer data, authenticates an account, deploys code, or opens a tunnel.

## Stub suite

From the repository root:

```powershell
pnpm --dir apps/dashboard exec playwright test --config ../../tools/distribution-harness/playwright.config.cjs
```

The default suite is explicitly tagged `@stub` and uses local HTTP on ports 4173 and 4174. It proves current widget.js behavior against a synthetic resolver stub, not the product `/api/widget-ready` route or persisted distribution state.

## A5 real-stack suite

Preconditions:

- Use only the task-owned local DB at `127.0.0.1:57905`, database `pathfinder_disposable_distribution_a5`; the fixture helper refuses any other host, port, or DB name.
- Apply the migrations, then seed one time with `pnpm --dir packages/db exec tsx ../../tools/distribution-harness/fixture-db.ts seed`. The manifest is `qa/distribution/real-fixture.json`; preserve it so the fixture suite can update its synthetic states. The control server restores the revoke case to ACTIVE at startup.
- Create a task-local TLS certificate with `tools/distribution-harness/create-local-tls-cert.ps1` and set `TORCHIKO_DISTRIBUTION_TLS_PFX` and `TORCHIKO_DISTRIBUTION_TLS_PFX_PASSWORD` for the local self-signed PFX.
- Set `DATABASE_URL` and `DIRECT_DATABASE_URL` to the exact disposable A5 database, `INTERNAL_POLICY_TOKEN` to a generated task-local value, and `TORCHIKO_DISTRIBUTION_REAL_STACK=1`. Supply structurally valid, local-only `test.invalid` fixture values through `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; the harness has no key defaults and refuses a missing pair. It supplies `RAILWAY_ENVIRONMENT=preview`. Never use a real Clerk key. Browser requests to every non-local origin are aborted.

Run:

```powershell
pnpm --dir apps/dashboard exec playwright test --config ../../tools/distribution-harness/playwright.config.cjs
```

Real-stack defaults: app origin `https://localhost:4173`, synthetic website origin `https://127.0.0.1:4174`, production standalone Next backend `127.0.0.1:4175`, and fixture-control HTTP `127.0.0.1:4176`. Set `TORCHIKO_DISTRIBUTION_WEB_PROXY_PORT=4185` when port 4175 is reserved for Android `adb reverse`; the backend then binds `0.0.0.0:4185` and its internal policy fetch uses `http://127.0.0.1:4185`. The local HTTPS proxy and host bind only to `127.0.0.1`/`::1`.

The proxy retains each real `/api/widget-ready/<slug>` request's `Origin` and `Sec-Fetch-Site` in `qa/distribution/playwright/<run-id>/cross-origin-requests.jsonl`; it does not log cookies or auth headers. Playwright's request API omits those fetch metadata headers in this environment, so the local proxy is the evidence source.

A5 covers real app/embed/probe routing, admitted launcher and inline origins, a manually attempted unadmitted iframe (CSP header plus browser error document), revocation after the 30-second cache TTL, disabled website surface, and paused venue. It tests the same product routes at desktop and 390px phone widths; revoke/disabled/paused mutations run once on desktop. The synthetic `/api/chat-stream` response is intercepted only to exercise UI state, clear-chat confirmation and WebView sessionStorage continuity. It is not DB-backed message persistence.

## Expo shell

The isolated Expo app under `expo-shell` has its own npm lockfile and is excluded from pnpm workspaces. Start with `npm ci`, then `npx expo start --lan`. See `expo-shell/README.md` for Android `adb reverse` real-route guidance and the iPhone fixture classification. `expo-doctor` and `expo export --platform android|ios` are packaging checks only; neither substitutes for an installed native WebView device run.
