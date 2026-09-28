# Visitor distribution

Torchiko serves one venue guide through the public chat page, a venue website, or an app WebView. The guide, knowledge, guest limits, and usage accounting are shared. Website and app access require separate default-off gates. This is the local Distribution RC-1 contract; it has not been deployed.

## URL map

| Visitor entry      | URL                           | Session entry surface | Framing                           |
| ------------------ | ----------------------------- | --------------------- | --------------------------------- |
| Direct             | `/<slug>/chat`                | Direct                | Self only                         |
| QR                 | `/<slug>/chat?source=qr`      | QR                    | Self only                         |
| Website launcher   | `/embed/<slug>`               | Website               | Self plus admitted active origins |
| Website inline     | `/embed/<slug>/inline`        | Website               | Self plus admitted active origins |
| App                | `/app/<slug>`                 | App                   | Self only                         |
| App compact header | `/app/<slug>?header=compact`  | App                   | Self only                         |
| App native header  | `/app/<slug>?header=none`     | App                   | Self only                         |
| Older app alias    | `/embed/<slug>?chrome=hidden` | App                   | Self only                         |

Website embed routes may include bounded `ask` and `place` start parameters while retaining the admitted-origin frame policy. Other queries on `/embed/<slug>` stay self-frame-only. An unknown or disabled venue returns the contained public unavailable boundary. A paused venue uses the existing temporary-unavailable presentation.

## Installation artifacts

The operator panel derives a public link, QR link, website snippets, and app URLs from one configured guest web origin and venue slug. Partner quick starts are [Add Torchiko to your website](add-to-your-website.md) and [Add Torchiko to your app](add-to-your-app.md). The [host bridge contract](host-bridge.md) explains the website JavaScript API and app close message. These Packet 3 additions remain local until the release is approved and deployed.

The website snippets are:

```html
<script
  src="https://<torchiko-web-origin>/widget.js"
  data-torchiko-venue="museum-slug"
  async
></script>
```

```html
<div data-torchiko-inline="museum-slug" style="height: 720px"></div>
<script src="https://<torchiko-web-origin>/widget.js" async></script>
```

`data-pathfinder-venue` remains a supported launcher alias. See [website installation](website-installation.md) and the [app WebView host guide](app-webview-host-guide.md) before giving an artifact to a venue.

## Gates and trust

Website effectiveness is the conjunction of `WEBSITE_DISTRIBUTION_ENABLED`, an active venue, the `widget` entitlement, and that venue's enabled website state. App effectiveness uses `APP_DISTRIBUTION_ENABLED`, the same active venue, `app-webview` entitlement, and enabled app state. `EMBED_PREVIEW_ENABLED=true` temporarily enables both global flags as a compatibility alias. All new gates default off. Website framing additionally needs an active exact HTTPS origin in the venue's origin list. The browser enforces that list through CSP `frame-ancestors`; the loader readiness probe only hides UI early and never grants framing.

Entry surface is route-declared, bounded, and stored once when an anonymous visitor session is created. A QR code is a URL, and anyone can open an app URL in a browser, so these counts are descriptive rather than verified installation evidence. The value never grants access or changes AI behavior. Existing public AI usage remains `guest-web`; this field is not a new billing or retention surface. Historical sessions with no value appear as Unknown.

An origin revocation or gate change reaches new iframe loads within the resolver cache's 30-second TTL. An already-open iframe remains until reload. Third-party storage can be partitioned or evicted, so website returning-visitor counts are best-effort.

All public distribution reads share a bounded resolver cache per server process; storage errors fail closed and expire after at most five seconds. Embed middleware fetches the frame policy from the same web server over its configured internal origin (loopback by default), with a server-only `INTERNAL_POLICY_TOKEN`. A missing token or failed fetch yields self-only framing. The internal policy route returns no origin list without the token.

## Operator boundary

Platform admins add or revoke exact origins and enable or disable surfaces with a reason. Changes are audited and revisioned. Tenant staff can read and copy their venue's artifacts but cannot change framing. Agents can read or propose a change; applying it uses the admin procedures. The Packet 3 bridge adds bounded host controls but no customer secret, API key, or native SDK. It sends no visitor conversation content to hosts.

The [operator runbook](operator-runbook.md) covers enablement and the rollback ladder. Every hosted flag, environment, database, deployment, and venue admission action needs a separate rollout decision. Distribution RC-1 ends at a ready-for-review PR and local/CI/device evidence, before staging.
