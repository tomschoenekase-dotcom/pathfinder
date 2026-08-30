# Dependency security current truth — 2026-08-30

This snapshot distinguishes production runtime exposure from development-tooling findings. It is
evidence for review, not an instruction to force dependency overrides outside supported ranges.

## Production boundary

- `pnpm audit:prod` reports no known production vulnerabilities at revision
  `aaa5d1c623e25d64efc38861fe46fbbe7c0a1810`.
- CI run `33327557524` completed successfully for that exact revision. Its production dependency
  audit step passed before the remaining migration, isolation, integration, browser, accessibility,
  type, lint, test, and build gates.
- `pdfjs-dist` is pinned to `6.2.108`, the root `nanoid` override to `3.3.18`, and the root
  `deepmerge-ts` override to `8.0.0`. A focused contract retains those reviewed minimums and the CI
  audit wiring.
- The production audit fails on high or critical advisories. Lower-severity production findings
  remain visible to the full audit and require explicit review rather than being silently treated as
  release proof.

## Retained development-tooling finding

The full dependency audit reports one low-severity Windows-only esbuild development-server path
traversal advisory, `GHSA-g7r4-m6w7-qqqr`, for resolved `esbuild@0.27.7`. The patched line begins at
`0.28.1`.

The retained paths are build/test tooling (`vitest`, `vite`, `tsx`, and the worker's `tsup`). The
application does not use esbuild's development server as a shipped runtime surface, and the
production-only audit is clean. Both the currently resolved Vite line and latest installed
`tsup@8.5.1` declare `esbuild: ^0.27.0`, which excludes `0.28.1`. Forcing an out-of-range override
would convert a low, local-development finding into an unreviewed compiler/bundler compatibility
change.

Retain the finding until the supported Vite/Vitest/tsup dependency graph accepts patched esbuild,
then upgrade it with worker bundles, source maps, tests, production builds, and browser gates. Until
then, do not expose an esbuild `serve`/`servedir` process on Windows, especially to an untrusted
network.

## Verification commands

- `pnpm audit:prod`
- `pnpm audit --json`
- `node --test scripts/production-dependency-audit-contract.test.mjs`
- `pnpm verify:release -- --profile candidate --revision <exact-clean-sha>`
