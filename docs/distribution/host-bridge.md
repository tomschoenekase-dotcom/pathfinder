# Torchiko host bridge v1

This contract connects the existing Torchiko guide to a website launcher, an inline frame, or an app WebView. The guide and chat pipeline remain shared across all doors. Distribution flags, venue entitlements, and the website's exact-origin frame policy still decide whether a door is available. The bridge grants no access by itself.

## Envelope and events

Messages use `{ source: 'torchiko', v: 1, type, payload }`. Unknown versions, types, malformed payloads, and oversized messages are ignored. The host API is `Torchiko.version`, `Torchiko.open({ ask?, place? })`, `Torchiko.close()`, and `Torchiko.on('ready' | 'open' | 'close', fn)`. The existing declarative launcher and inline snippets continue to work.

| Direction    | Type              | Payload                             | Effect                                                       |
| ------------ | ----------------- | ----------------------------------- | ------------------------------------------------------------ |
| Guide → host | `ready`           | none                                | The admitted guide frame has initialized.                    |
| Guide → host | `open`            | none                                | The guide became visible.                                    |
| Guide → host | `close-requested` | none                                | The visitor asks the native host to close its Ask surface.   |
| Guide → host | `height`          | `{ height: number }`                | Bounded inline resize hint.                                  |
| Guide → host | `place-action`    | `{ placeId: string, name: string }` | App doors only: the visitor tapped an opted-in place button. |
| Host → guide | `open`            | none                                | Notify an existing guide frame that its host surface opened. |
| Host → guide | `close`           | none                                | Notify an existing guide frame that its host surface closed. |
| Host → guide | `prefill`         | `{ ask?: string, place?: string }`  | Apply bounded, unsent start input and a public venue place.  |

### Place actions (app doors, v1.1)

An app host may add `placeAction` to its `/app/<slug>` URL. `placeAction=1` shows a button labelled "Open in app" on every place card the guide recommends; any other value of 1–32 characters on one line is used as the label instead (for example `placeAction=See%20in%20your%20pass`). An invalid or oversized value is ignored and no button appears. When the visitor taps the button, the guide posts `{ source: 'torchiko', v: 1, type: 'place-action', payload: { placeId, name } }` through the same native channel as `close-requested`. The host maps `placeId` to its own screen (a ticket, an attraction page, a map pin) and navigates there. The guide stays loaded underneath, so returning to it keeps the conversation.

`placeId` is the same public place ID that the `place` start parameter accepts, so one mapping table serves both directions: _attraction screen → guide_ with `place`, and _guide → attraction screen_ with `place-action`. `name` is the public place name, for logging or a fallback lookup. Nothing else is sent: no visitor text, answer, session or visitor identifier. A tap is counted as a `visitor.action.clicked` analytics event with the key `host.open-in-app` only after a native channel accepted the message. Website embeds do not emit `place-action` in v1.1.

`ask` is at most 200 characters and only fills the composer. It never sends a message. `place` is a bounded place ID and applies only when the place is public for the current venue. Invalid or unavailable values are silently ignored. Presence may be logged as booleans; the text and place ID are not written to analytics or host events. A guide URL may also carry `ask` and `place`. Route parsing never changes venue access or chat accounting.

## Trust boundaries

The website guide accepts a `message` only when its `event.source` is its parent window, its `event.origin` is an exact active origin from the venue's server-resolved distribution policy, and the envelope passes validation. The loader accepts messages only from its own iframe window at the exact Torchiko web origin. The loader sends to that exact origin, not `*`. Frame admission remains enforced by CSP `frame-ancestors` on canonical website embed routes; a readiness probe cannot grant admission. Origin revocation affects new frame loads after the resolver's documented 30-second TTL; an already open frame lasts until reload.

An app WebView is a top-level guide route with the app gate. A native host sends `prefill` by injecting `window.postMessage(envelope, window.location.origin)` into the loaded guide document (`injectJavaScript`, `evaluateJavaScript` or `evaluateJavascript`) after the guide's `ready` message. The app guide accepts only `prefill` from that same document and origin, with the same bounds as website prefill; it ignores `open` and `close` there, because the native host owns visibility. It may emit the same lifecycle envelope through `ReactNativeWebView.postMessage`, `webkit.messageHandlers.torchiko.postMessage`, or a parent frame when available. `header=none` removes the Torchiko back control and lets the native host own close. Native hosts validate the message shape and known guide URL before acting. The bridge never sends visitor messages, answers, tokens, session IDs, or other visitor identifiers to a host.

## Threat notes

- **Spoofed origins and frames:** compare exact origins and `event.source`; never trust a claimed origin or slug inside `payload`. A host page outside the active allowlist cannot become trusted by passing an origin query parameter.
- **Message floods:** accept only known types and bounded payloads; throttle height signals and do no network work for repeated lifecycle messages. Invalid messages fail closed.
- **Clickjacking:** the existing CSP `frame-ancestors` policy controls website framing. App and query-bearing aliases remain self-frame-only. The host bridge does not weaken that policy.
- **Oversized prefill:** cap `ask` at 200 characters before URL construction and again in the guide. Never auto-send, so opening a guide cannot consume a chat turn.
- **Place-action spoofing:** the host must still check the message comes from the main frame at the exact guide origin. A place ID is a public identifier, so a forged message could at most open one of the host's own screens; hosts must not treat it as a purchase, entitlement or identity signal. The label is plain text rendered by React, bounded to 32 characters, and rejects control and bidirectional-override characters.
- **Revocation lag:** the server resolver caches distribution policy for at most 30 seconds. Tests must wait for that TTL and create a new frame when proving revocation.

## Compatibility and proof

The old `data-torchiko-venue`, `data-torchiko-inline`, and `data-pathfinder-venue` installs remain supported. Unit and route tests cover malformed values, origin checks, and default-off behavior. A two-origin browser harness proves admitted and revoked frames, loader events, unsent prefill, mobile layout, and an app route with `header=none`. Device or emulator evidence is identified separately from mobile browser emulation.
