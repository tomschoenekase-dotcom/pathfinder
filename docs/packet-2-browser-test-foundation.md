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

This remains the fast DOM integration and route-adapter inner loop. A complementary real-Chromium
gate now exists at `pnpm test:visual-browser`; see `docs/mobile-visual-browser-smoke.md`. That gate
adds representative phone/tablet/desktop rendering, keyboard interaction, browser-computed axe
checks, and screenshots for Guest PathFinder, the single-venue portal, and remote onboarding.

Neither gate proves pixel-baseline visual regression, real Clerk redirects, a deployed origin,
provider behavior, a live database flow, real devices, or assistive-technology behavior.

## Automated accessibility inner loop

`pnpm test:accessibility` is a second CI-wired, credential-free gate. It runs axe-core against
representative Admin OS, Internal Workspace, client portal, and structured guest-answer states in
the same jsdom environment. The command fails on any violation axe can establish from the rendered
DOM and includes rule IDs plus affected-node counts in its assertion output.

The local scan deliberately disables only axe's `color-contrast` rule because jsdom has no layout or
computed pixel colors. It does not replace keyboard contracts in the browser-foundation suite, a
zoom/reflow and high-contrast review or screen-reader testing. The complementary Chromium gate now
adds browser-engine axe scans including computed color contrast for its three synthetic journeys,
but those remaining checks are still required before a production accessibility claim.
