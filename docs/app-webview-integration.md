# App web-view integration

PathFinder's controlled embed route can serve as the top-level page for an app's **Ask PathFinder** tab. This is a web integration contract, not a native SDK or a third-party website widget.

## Admission and URL

The route remains behind the default-off `EMBED_PREVIEW_ENABLED=true` server flag. Enabling it is a separate environment and rollout decision.

Build the URL from the exact PathFinder web origin and a URL-encoded venue slug:

```text
https://<pathfinder-web-origin>/embed/<venueSlug>?chrome=hidden
```

Only one exact query parameter selects the native-shell presentation: `chrome=hidden`. A missing, unknown, differently cased, repeated, array-valued, or additional parameter falls back to the ordinary controlled embed. The parameter only removes the `Powered by PathFinder` footer; it does not identify a tenant or venue, grant access, bypass the feature flag, alter rate limits, or change venue resolution.

The venue header, language picker, new-conversation control, location state, AI guidance, errors, and chat composer remain inside the web content. The native shell should supply its own tab and navigation chrome.

## Native-shell boundary

- Navigate the web view directly to the HTTPS URL; do not place it in another iframe. Every query-bearing embed, including `?chrome=hidden`, remains same-origin-frame-only even if the separately configured website-widget preview is enabled.
- Allow JavaScript and first-party session storage. PathFinder uses an anonymous per-venue browser session; do not inject cookies, API keys, tenant IDs, authorization headers, or native secrets.
- Allow location only when the app and operating system have obtained the visitor's permission. Knowledge questions continue to work when location is denied or unavailable. A non-location guide does not request visitor location.
- Keep navigation on the configured PathFinder origin inside the web view. Open explicit external actions, such as Google Maps directions, with the operating system after normal user confirmation.
- Preserve platform accessibility features, keyboard input, text scaling, safe areas, and reduced-motion preferences. Do not overlay native controls on the chat composer or disclosure.
- On a shared device, clear the web view's first-party site data when the host app's own privacy/session policy requires it. This integration does not define PathFinder's server retention period or deletion policy.

## States the shell must handle

- A disabled preview or unknown venue returns the contained not-found boundary.
- A paused venue renders the generic temporarily-unavailable state without home navigation.
- Provider or network failures remain inside the shared chat's controlled error/fallback experience.
- Removing `chrome=hidden` returns to the ordinary controlled embed. Disabling `EMBED_PREVIEW_ENABLED` is the fail-closed rollback for the entire route.

## Deliberate limitations

There is no native bridge, native SDK, publishable widget key, API key, write API, or separate web-view analytics dimension in this slice. A separate default-off website-widget preview may use a server-owned exact-origin allow-list, but it cannot frame the `?chrome=hidden` presentation. The ordinary guest-chat tenant resolution, admission, incident controls, and usage attribution remain authoritative. Test this contract in an authorized isolated staging environment before any app exposure.
