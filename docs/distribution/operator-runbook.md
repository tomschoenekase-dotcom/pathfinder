# Visitor distribution operator runbook

This is a code-level RC-1 procedure. Do not perform its hosted steps until Tom authorizes the relevant rollout rung. No RC-1 build or PR changes a hosted environment, deployed flag, or customer venue.

## Give a partner the right installation details

Before sending instructions, confirm the release containing the app and website doors is deployed and the venue is active. Check which door the partner wants:

- **Website:** Confirm the venue has website access in its plan, turn on website access for that venue, and add each exact HTTPS website origin in platform admin **Visitor access**. Include the production origin and any preview origin the partner will test. Enable the overall website switch only under the approved rollout. Check that the admin screen reports access as on. Send the venue slug, exact public Torchiko web origin, and [Add Torchiko to your website](add-to-your-website.md). Ask the partner to test from each allowed origin.
- **App:** Confirm the venue has app WebView access in its plan and turn on app access for that venue. Enable the overall app switch only under the approved rollout. Check that the admin screen reports access as on. Send the exact `https://.../app/<slug>?header=none` URL, the venue's app background color, and [Add Torchiko to your app](add-to-your-app.md). Ask for a device or emulator check. A website origin entry is not needed for a top-level app WebView.

Neither snippet contains a secret. Pasting code does not enable access: the venue and overall switches must already be on. If the door does not load, check the admin access status, the exact origin for websites, and the partner site's Content Security Policy before changing anything. The native reference snippets are examples awaiting compilation and device verification by the integrating app team.

## Enable one venue

1. Confirm the exact deployed revision, venue ID/slug, configured guest web origin, tenant, and intended surface. Confirm the venue is active and its normal public chat/QR route works.
2. Confirm the `widget` entitlement for website access or `app-webview` entitlement for app access. The app plan mapping is initially mirrored from existing widget mappings; an entitlement still does not enable the surface by itself.
3. For a website, normalize and verify each exact HTTPS host origin. In platform admin **Visitor access**, add the origin with a meaningful reason. Never use a wildcard, path, query, or visitor-supplied header as authority. The active-origin cap is 20 per venue.
4. Enable the venue surface with a reason in the same admin tab. Each change writes audit history and advances the venue distribution revision. Tenant staff can read status and copy artifacts but cannot make these changes. Agent proposals require an admin to apply them.
5. Enable the relevant global flag only under the rollout decision: `WEBSITE_DISTRIBUTION_ENABLED` or `APP_DISTRIBUTION_ENABLED`. `EMBED_PREVIEW_ENABLED=true` is a temporary compatibility alias for both. Confirm the effective readback shows no deny reason.
6. Copy the derived snippet or app URL from the configured guest web origin. Give the [website installation guide](website-installation.md) or [app host guide](app-webview-host-guide.md) to the venue. Verify the real host page or app device at desktop and phone widths, including ready/open/reopen, external actions, and CSP.
7. Record the exact revision, venue, origins, gate state, test host/device, and screenshots in the rollout evidence. A green local test is not evidence that hosted flags, entitlement, CSP, or device behavior worked.

The optional `scripts/import-widget-preview-origins.mjs` reads legacy `WIDGET_PREVIEW_ORIGINS_JSON` and is dry-run by default. Use `--write` only as an explicitly authorized operator action against the intended environment after reviewing the proposed rows. RC-1 does not run it against a hosted database.

## Revoke and roll back

Changes affect **new** iframe loads within the resolver's 30-second cache TTL. An already-open iframe can continue until reload. Verify a new load after waiting for the TTL.

Use the smallest appropriate data-preserving control:

1. Revoke one website origin with a reason to stop one host.
2. Disable website or app for one venue with a reason.
3. Add a tenant entitlement DENY override for `widget` or `app-webview` through existing entitlement controls.
4. Turn off the relevant global distribution flag. Check the legacy `EMBED_PREVIEW_ENABLED` alias too; if it remains true, it can keep both effective.
5. Revert code through the normal reviewed release process. The additive distribution migration can remain; do not delete venue/origin rows to roll back.

The public `/chat` and QR routes continue under their existing venue controls. Never edit an applied migration or change guest disposition/usage accounting as a shortcut.
