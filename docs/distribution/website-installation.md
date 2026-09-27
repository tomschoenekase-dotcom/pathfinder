# Install the Torchiko guide on a venue website

Ask Torchiko for the exact venue slug and confirm that your website's **HTTPS origin** (scheme, host, and optional port; no path) has been admitted. Torchiko enables website access per venue. The script contains no secret, key, or tenant identifier.

## Floating launcher

Place this once, preferably near the end of the page:

```html
<script
  src="https://<torchiko-web-origin>/widget.js"
  data-torchiko-venue="museum-slug"
  async
></script>
```

The launcher is themed by the public venue presentation and opens the same guide visitors reach by QR. It loads the conversation iframe only after a visitor opens it. Closing and reopening keeps the iframe mounted during that page visit.

## Inline guide

Reserve a visible area in an “Ask the Museum” page:

```html
<div data-torchiko-inline="museum-slug" style="height: 720px"></div>
<script src="https://<torchiko-web-origin>/widget.js" async></script>
```

Choose a responsive height appropriate to the host page. The iframe fills its container. A launcher and inline guide can appear on the same page. Each element mounts once. If readiness fails, the loader leaves no visible broken widget.

## Host Content Security Policy

If your website sets CSP, allow the exact Torchiko web origin in `script-src`, `style-src`, `connect-src`, and `frame-src`. Keep any other restrictions your site needs. For example, add `https://<torchiko-web-origin>` to each directive rather than using a wildcard. The Torchiko page's own `frame-ancestors` policy must separately admit your exact active origin. A blocked script, stylesheet, probe, or frame makes the guide unavailable; the launcher is designed to fail invisibly.

The loader uses a credential-free, no-referrer readiness request. A readiness response does not grant framing. Torchiko's CSP is the browser-enforced boundary. The legacy `data-pathfinder-venue` launcher attribute is accepted for existing installations; new snippets use `data-torchiko-venue`.

## Check before sharing

Open the actual host page at desktop and phone widths. Verify that the launcher opens, the guide becomes ready, close/reopen retains a conversation, the inline guide fits without horizontal scrolling, and a site whose origin is not admitted cannot frame the guide. Check keyboard focus and the page's consent/privacy copy. An unadmitted or disabled site should not show a dangling launcher. The public chat and QR links remain available according to ordinary venue state even when website distribution is off.

For the gate and rollback rules, see the [distribution contract](README.md) and [operator runbook](operator-runbook.md).
