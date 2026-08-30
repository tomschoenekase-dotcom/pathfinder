# PWA offline lifecycle

PathFinder's service worker is a narrow reliability fallback, not an offline application shell. It caches only the generic `/offline.html` document. It does not cache venue pages, chat messages, API responses, operational updates, static application assets, location, session identifiers, analytics, or tenant data. Chat sends and client-side transitions still require the network.

## Loaded guest chat behavior

An already-loaded guest chat listens to the browser's online/offline signal as an advisory connectivity boundary. While the browser reports offline, PathFinder:

- keeps the composer editable and preserves its draft in the current React page only;
- blocks send, quick prompts, assistant choices, exact retry/check actions, new-conversation rotation, and Voice Mode startup;
- does not queue or automatically send a draft;
- labels the interruption without claiming that any unconfirmed message was delivered.

After an online event, the controls reopen, session preparation runs again, and a five-second status confirms that the visitor can decide what to send or retry. A frozen retry still uses the server-backed exact-operation recovery path; reconnection does not create a new operation identity or imply a delivery outcome.

`navigator.onLine` can report connectivity to a network that still cannot reach Torchiko, so this UI is not proof of server availability. Normal request error classification, idempotency, reconciliation, and retry controls remain authoritative. The draft is not persisted to local storage and will be lost if the visitor reloads or closes the page.

The worker intercepts only same-origin `GET` document navigations. It tries the network first and uses the generic page only when that navigation fails. Non-navigation traffic, writes, API calls, assets, and cross-origin requests remain under normal browser networking.

## Version and diagnostics

- Current owned cache: `pathfinder-offline-v2`.
- Activation deletes only older names beginning with `pathfinder-offline-`; it does not delete another application's caches.
- `/sw.js` registers at scope `/` with `updateViaCache: none`. The manifest declares the same root scope.
- The root element exposes `data-pathfinder-offline-support` as `registering`, `registered`, `unsupported`, `retiring`, `retired`, or `unavailable` for browser smoke tests.
- Registration or retirement failure emits the detail-free `pathfinder:offline-support-unavailable` event and a generic errors-only monitoring exception. Raw browser errors, URLs, and visitor data are not attached.

## Forward retirement and rollback

A Git revert alone does not unregister a service worker that already controls a browser. To retire offline support, make a forward deployment on the same origin with `NEXT_PUBLIC_PWA_ENABLED=false`. When an online client loads that release, PathFinder requests only the root-scope registration, attempts unregistration first, and then independently deletes only `pathfinder-offline-` caches. Either failure leaves the diagnostic state at `unavailable`, without preventing the other cleanup attempt. Leave that retirement release available for the approved stabilization window so returning clients can receive it before removing the registrar or worker files.

Unregistering does not replace the worker already controlling the current document. During a retirement smoke test, reload or close every open PathFinder tab while online after it reaches `retired`; then confirm the root registration and owned caches remain absent. This current-client lifecycle limitation is why the forward retirement release must remain available through the stabilization window.

Re-enable with `NEXT_PUBLIC_PWA_ENABLED=true` in a later reviewed deployment. A local code revert is appropriate before exposure; after exposure, use the forward retirement path. Neither action is authorized by this document, and a real production-build browser smoke remains required before rollout.
