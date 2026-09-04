# Hosted authenticated surface evidence

This operator-only harness captures passive screenshots of reviewed Railway staging admin routes at
phone and desktop sizes. It exists to make the remaining authenticated UI evidence repeatable; it
does not create an identity, bypass Clerk, mutate product state, or authorize production access.

## Safety boundary

- Use only an authorized, staging-only Clerk session exported by the session owner.
- Keep the Playwright storage-state JSON outside the repository. The harness rejects repository
  paths and symbolic links, and it never copies or names the session file in its report.
- Treat every screenshot as potentially sensitive. Output stays under the gitignored
  `artifacts/hosted-authenticated-surfaces/<revision>/` directory and must not be committed. A route
  passes only when its fixed product-specific evidence markers are visible: Founder Control Room plus
  queue pause state, Clients plus its labeled search input, or Outreach center plus loaded outreach
  readiness. A generic authenticated shell, loading-only render, or wrong route cannot pass merely by
  containing a `main` landmark. Explicit additional routes retain the generic authenticated-route
  contract unless a product-specific marker set is added in code.
- The route allowlist accepts only explicit `/admin/...` paths without query strings, fragments, or
  dynamic identifiers. The default set is `/admin/operations`, `/admin/directory`, and
  `/admin/prospects/outreach`.
- The harness performs navigation and screenshot capture only. It does not click controls or submit
  forms. It records request-method counts, but does not retain request URLs, bodies, headers,
  credentials, rendered text, or browser-console text.
- A passing run proves only that the exact-revision staging health contract passed and the selected
  same-origin routes rendered a `main` landmark without a sign-in redirect or browser error. It does
  not prove representative customer data, database latency, provider quality, accessibility,
  physical-device behavior, billing, outreach, or production readiness.

## Authorized execution

From the repository root, set the opt-in for this one process and pass the exact deployed staging
revision plus the external session-state path:

```powershell
$env:PATHFINDER_ALLOW_AUTHENTICATED_HOSTED_CAPTURE = '1'
pnpm dashboard:hosted-authenticated-surfaces `
  --revision <exact-40-character-staging-revision> `
  --session-state <absolute-path-outside-repository-to-authorized-staging-session.json> `
  --ack-sensitive-local-artifacts yes
Remove-Item Env:PATHFINDER_ALLOW_AUTHENTICATED_HOSTED_CAPTURE
```

Repeat `--route /admin/...` to replace the default route set with up to eight explicit safe admin
routes. The command fails closed when health does not match the requested revision, the session
redirects to sign-in, navigation crosses origins, a route changes, the main landmark is absent, a
browser error occurs, or a screenshot is missing.

The generated `report.json` contains only bounded metadata and screenshot hashes/paths. Review the
local pixels, record only sanitized conclusions in durable evidence, then remove the local artifact
directory when it is no longer needed.
