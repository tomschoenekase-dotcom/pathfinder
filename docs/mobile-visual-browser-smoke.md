# Mobile visual browser smoke

`pnpm test:visual-browser` is the deterministic real-Chromium smoke gate for three launch-critical
surfaces at representative phone (390x844), tablet (820x1180), and desktop (1440x900) viewports:

- Guest PathFinder with the real route-planner component, reviewed synthetic locations, accessible
  routing, a long conversation, Tochi, and Voice Mode controls.
- The ultra-simple single-venue client home, including its primary keyboard path.
- Remote onboarding with focused questions and a keyboard-reachable help action.

The nine tests fail on horizontal overflow, unexpected console/page errors, axe violations
including browser-computed color contrast, missing keyboard focus, or an empty screenshot. The
Guest test additionally verifies that the product body remains viewport-bound while route details
are open. Screenshots, traces, and reports are generated under ignored test-output directories.

The fixtures reuse production components and inject only deterministic, synthetic data. They do not
authenticate, contact a provider, read a database, mutate customer state, or call staging. Next.js
and Clerk development prompts are removed from screenshots; product DOM is not hidden.

## Evidence boundary

This gate proves real Chromium rendering and interaction for the named synthetic states. It is not a
pixel-baseline visual-regression system and does not prove real devices, screen readers, authenticated
Clerk redirects, deployed origins, provider quality, live Voice/WebRTC, databases, or customer data.
Those require separately authorized evidence. A green candidate release remains staging-review
evidence, not production approval.

CI installs the Playwright-pinned Chromium runtime before running this gate. Local machines can run:

```powershell
pnpm --dir apps/dashboard exec playwright install chromium
pnpm test:visual-browser
```
