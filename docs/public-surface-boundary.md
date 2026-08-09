# Public surface inventory boundary

PathFinder keeps a reviewed, machine-readable inventory of every currently mounted unauthenticated tRPC procedure, every explicit Next.js HTTP route handler, and every dashboard API path allowed through Clerk middleware without a session.

Run the boundary locally with:

```sh
pnpm verify:public-surfaces
```

CI runs the same DB-free command before database-dependent checks. The verifier fails when source discovery and `packages/api/src/testing/public-surface-manifest.json` differ.

## What is pinned

- The inventory starts at exported `appRouter`, recursively follows static mounted routers and `mergeRouters`, resolves local and imported procedure wrappers, and classifies the canonical procedure builders in `packages/api/src/trpc.ts`.
- Both Next.js tRPC transports must import and pass canonical `appRouter` to `fetchRequestHandler`.
- All recognized `route.js`, `route.ts`, and related JS/TS module variants under `apps` are inventoried by explicit HTTP method.
- The dashboard `PUBLIC_ROUTES` API subset must exactly match the manifest.
- Each manifest entry has a compatible exposure/control profile and either repository-contained behavioral test evidence or a nonblank exception. Evidence paths must resolve to regular test files inside this repository.
- Symbolic links, wildcard route exports, dynamic router shapes, unresolved procedure bases, and dynamic public-path declarations fail closed.

## Review workflow

When a public surface is intentionally added, removed, or changed:

1. Add or update focused behavioral coverage for admission, ownership, bounds, failure behavior, and safe errors as applicable.
2. Update the manifest in the same change with the exact transport, method or procedure kind, exposure, control profile, and test path.
3. Run `node --test scripts/public-surface-boundary.test.mjs`, `pnpm verify:public-surfaces`, and the affected application/package tests.
4. Review the manifest diff as a security-boundary change, not a generated-file refresh.

## Proof boundary

This is a static change-detection and review gate. It does not prove runtime authentication, authorization, resource ownership, tenant isolation, rate limits, webhook signature validity, live routing, or deployment state. Those properties require the referenced behavioral tests and, where applicable, exact-revision staging evidence.
