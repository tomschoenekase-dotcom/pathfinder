# Packet 2 browser test foundation

`pnpm test:browser-foundation` is the local, credential-free browser-surface gate for Packet 2. It
runs focused Vitest/jsdom contracts against the real React components and route adapters for all
four product surfaces:

- **Admin OS:** semantic navigation landmarks, exact active-route state, primary operator exits,
  responsive navigation, scroll locking, Escape dismissal, and focus restoration.
- **Internal Workspace:** client versus venue scope, multi-venue navigation, workflow grouping, and
  explicit guest-preview links.
- **Ultra-simple client portal:** single-venue and multi-venue presentation, lifecycle actions,
  internal-language exclusion, analytics absence, and legacy-route redirects.
- **Guest experience:** standalone, embed, and web-view presentation contracts; venue transitions;
  structured response accessibility and safe URL handling; place actions; language direction; and
  resilient private-session states.

The gate is deterministic and performs no network calls, authentication, provider access, database
access, or staging access. CI runs the same command before the full monorepo test suite.

## Evidence boundary

This is a DOM integration and route-adapter foundation, not a real-browser end-to-end suite. The
repository does not currently include Playwright or a pinned browser binary, and this implementation
does not download either during an offline/local test run. Therefore it does **not** prove browser
engine layout, visual regression, real Clerk redirects, a deployed origin, or a live database flow.

When a browser dependency and runtime are deliberately approved, this gate should remain the fast
inner loop. A later Playwright layer can then exercise the same four surfaces against an explicitly
authorized disposable environment with synthetic identities and seeded tenant data.
