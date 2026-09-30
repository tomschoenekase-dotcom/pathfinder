# Operator OAuth and approvals

The Dot operator connects to Torchiko as an MCP client over OAuth 2.1. Torchiko is the
authorization server; Clerk is only the login. Everything here is dark until
`OPERATOR_OAUTH_ENABLED=true`, and every write is a proposal.

## Endpoints (dashboard origin)

| Path                                                           | Purpose                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /.well-known/oauth-authorization-server`                  | RFC 8414 metadata                                                        |
| `GET /.well-known/oauth-protected-resource[/api/operator/mcp]` | RFC 9728 metadata                                                        |
| `POST /oauth/register`                                         | RFC 7591 public-client registration                                      |
| `GET /oauth/authorize`                                         | Consent page (platform admin, allowlist, strict reverification)          |
| `POST /oauth/token`                                            | `authorization_code` (S256 PKCE) and rotating `refresh_token`            |
| `POST /oauth/revoke`                                           | RFC 7009; revoking a refresh token revokes the whole grant               |
| `POST /api/operator/mcp`                                       | MCP resource; 401 carries `WWW-Authenticate: Bearer resource_metadata=…` |
| `GET /approve/[id]`                                            | One-tap approval page for a proposal or plan                             |

## Settings (names only; values live in the hosting provider)

- `OPERATOR_OAUTH_ENABLED`: `true` to turn the surface on. Default off.
- `OPERATOR_OAUTH_ISSUER`: the exact dashboard origin, for example the production app origin.
- `OPERATOR_OAUTH_PEPPERS`: `kid:base64url` pairs, comma-separated, 32+ random bytes each. The
  first key signs new digests; keep the old key listed while rotating. Separate per environment.
- `OPERATOR_OAUTH_REDIRECT_ORIGINS`: exact HTTPS origins of connector callbacks. ChatGPT does not
  display its callback; a rejected registration records the callback origin in the operator audit
  trail (`oauth.register` / `REDIRECT_URI_REJECTED`), so add that origin and retry.
- `OPERATOR_OAUTH_ALLOWED_USER_IDS`: user IDs allowed to consent and approve (also PLATFORM_ADMIN).

An enabled but incomplete configuration answers 503; it never stops the dashboard from booting.

## Connecting (arming)

1. Open `/oauth/arm` in the dashboard and tap "I am connecting the operator now" (Face ID or
   passkey via Clerk reverification).
2. Within 10 minutes, add the connector in ChatGPT with the MCP URL and OAuth.
3. Approve the consent page ChatGPT opens. It shows the app name, redirect host and how long ago
   the app registered.

Consent without a fresh arming is refused, and each arming covers one consent. This stops a
consent link produced by someone else's connector (same callback host) from connecting their app.

## Tokens

Opaque 256-bit values; only `HMAC-SHA-256(pepper[kid], token)` and the kid are stored.

- Code `pf_oac_…`: 60 s, single use, bound to client, exact redirect URI, S256 challenge and
  resource. A replayed code revokes the grant.
- Access `pf_oat_<stg|prd>_…`: 60 min (the plan's fallback while ChatGPT refresh behaviour is
  unverified), audience = the exact resource URL. The other environment's prefix never verifies.
- Refresh `pf_ort_<stg|prd>_…`: rotates on every use; 7-day idle and 30-day absolute limits, never
  beyond the grant. Reusing a rotated refresh token revokes the grant and all its tokens.
- Every MCP call re-reads token, grant and client rows, so revocation is immediate. Removing the
  consenting user from `OPERATOR_OAUTH_ALLOWED_USER_IDS` stops their grants at once.

## Grants, scope and autonomy

Consent creates an `OperatorGrant`: tenants (or all, including new ones), capabilities and an
expiry of at most 90 days. Tool arguments name tenants and venues; anything outside the grant is
`NOT_FOUND`, identical to a missing target. Reads use a per-call, read-only credential scope built
from the grant so existing read services enforce their own checks.

Writes create an `OperatorProposal` (operationId-idempotent, argsHash-bound, target version,
72 h expiry). `OperatorAutonomyPolicy` says `ask` (default) or `auto` per capability. There is no
MCP tool that reads-writes the policy; `customers.invite` and reverts are always-ask in code, and
plans auto-apply only when every step is auto. `_meta` approval claims are ignored.

Approval (page or dashboard) needs a Clerk session, the allowlist, same-origin POST and a strict
reverification (Face ID or passkey). The POST carries the argsHash that was shown. Apply claims the
row with compare-and-set (a double approve applies once), checks the target version (mismatch →
`STALE`), calls the canonical domain action with the human as actor, and stores before/after
snapshots. Plans apply steps in order and stop at the first failure; later steps close as
`REJECTED`/`PLAN_STOPPED`. Undo is a new always-ask `operator.propose_revert` proposal.

## Audit

`operator_audit_events` is append-only (database trigger blocks UPDATE, DELETE and TRUNCATE). One
row per MCP call (denials by issued tokens included), OAuth event and proposal or plan
transition. Guessed tokens and rate-limited registrations go to the logger only, and rejected
redirect registrations write at most one row per ten minutes, so anonymous traffic cannot grow
the append-only table. Arguments are
redacted: no token material, free text reduced to its length, email local parts masked. Canonical
domain actions still write the existing `AuditLog`.

## Adding a proposal kind

Copy `packages/api/src/operator/kinds/appearance.ts`: parse with the P2 contract, check scope,
bind `targetVersion`, snapshot, apply through the canonical domain action with the human actor,
and implement `revert` from the snapshot. List it in `kinds/index.ts`.

## Proof

- `packages/api/src/operator/*.test.ts`: tokens, PKCE, redirect rules, config, redaction, autonomy.
- `operator-oauth.disposable.integration.test.ts`: the full security list on PostgreSQL with every
  migration applied (CI step "Verify operator OAuth, grants, proposals and approvals").
- `apps/dashboard/app/api/operator/operator-human-routes.test.ts`: consent/approve guards.
