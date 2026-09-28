# App WebView host guide

Load the venue's canonical `https://<torchiko-web-origin>/app/<slug>` as the
top-level page of the native Ask tab. Use `?header=none` when the native screen
provides the title and Close control, or `?header=compact` for a small guide
header with a `close-requested` control. The compatible
`/embed/<slug>?chrome=hidden` alias renders the same visitor surface. These
public routes require no customer secret, cookie injection, API key, tenant ID,
or special request header.

The operator's artifact/readback supplies both the guide URL and the venue's
validated **app background color**. Apply that color to the host view, WebView,
and WebView scroll surface before starting the first load. This avoids a white
flash while the themed document paints.

## One long-lived WebView

Keep one guide WebView instance alive while the visitor switches between native
tabs. The conversation lives in that WebView's `sessionStorage`; recreating the
instance starts a new conversation. A persistent website data store preserves
the returning-visitor identifier in `localStorage`, but does not preserve the
conversation. Relaunching the app starts a fresh conversation (D6).

Keep the WebView inside the content area above native tabs and safe areas. Do
not overlay controls on the composer or AI-guidance disclosure. Enable
JavaScript and first-party DOM storage. Same-origin Torchiko navigation stays
inside the WebView. Explicit off-origin HTTPS links and `target="_blank"`
actions go to the OS, allowing verified universal/app links to open the venue's
own ticket app. Route `tel:`, `mailto:`, and supported map URLs through the
platform URL handler. Never pass web content to `Intent.parseUri`; use plain
`ACTION_VIEW` with an explicit scheme allowlist. The native host owns navigation
gestures.

The guide now renders confirmation prompts in-page as accessible, themed
dialogs. Hosts do not need JavaScript confirm handlers or iframe `allow-modals`.

## iOS — Swift / WKWebView

- Create the guide controller and its `WKWebView` once. Use the default
  `WKWebsiteDataStore` for returning-visitor storage, and keep the same view
  attached while Ask is hidden.
- Set `isOpaque = false`, `backgroundColor`, and
  `scrollView.backgroundColor` to the operator's app background before loading.
  Constrain the view inside the safe area and above the native tab bar.
- In `WKNavigationDelegate`, allow guide-origin top-level navigation. Send
  off-origin navigation to the OS. For `targetFrame == nil`, route the action
  through the same external-link policy and do not create another WebView.
- Try `UIApplication.open(url, options: [.universalLinksOnly: true])` first for
  off-origin HTTPS actions; when no app claims the URL, fall back to
  `SFSafariViewController`. Use `UIApplication.open` for allowed `tel:`,
  `mailto:`, and map schemes. iOS presents its normal call confirmation; do not
  place a call automatically.
- Implement `webViewWebContentProcessDidTerminate` and reload the current guide
  URL so memory-pressure recovery does not leave a blank tab. Show host retry UI
  only when the initial top-level load fails; after first paint, keep the
  guide's own offline and error states.
- On iOS 15+, implement `WKUIDelegate.requestMediaCapturePermissionFor` and
  grant only microphone capture requested by the exact guide origin after the
  visitor starts voice. Include `NSMicrophoneUsageDescription`. For location,
  include `NSLocationWhenInUseUsageDescription` when offered and expect both
  the OS permission and WebKit's web-origin location prompt. D7 allows entitled
  voice subject to those host and OS permissions.
- Test the software keyboard, safe areas, Larger Text, and reduced-motion
  behavior on a physical phone. WKWebView does not automatically map Dynamic
  Type to page text; the host may choose `pageZoom` after testing its larger-text
  setting against the guide's responsive layout.

## Android — Kotlin / Android WebView

- Keep one Activity-owned WebView through Ask tab switches. Enable JavaScript,
  DOM storage, and geolocation support. Set `setSupportMultipleWindows(false)`;
  `_blank` then reaches `shouldOverrideUrlLoading` and follows the same external
  URL policy.
- Set `webView.setBackgroundColor(appBackground)` before load. Keep it above
  native tabs and use the operator's app background on the container too.
- In `WebViewClient.shouldOverrideUrlLoading`, allow same-origin HTTPS main-frame
  navigation. Route off-origin HTTPS, `tel:`, `mailto:`, and supported `geo:`
  links through plain `Intent(ACTION_VIEW, uri)` with `CATEGORY_BROWSABLE`. Never
  parse an intent URI from page content.
- Implement `onRenderProcessGone`, remove and destroy the dead WebView, create a
  replacement, attach it to the same container, and return `true`. Without this
  handler Android can terminate the host app when the renderer dies.
- For apps targeting SDK 35+, edge-to-edge is the default and
  `adjustResize` no longer resizes content around the keyboard. Apply
  `WindowInsetsCompat.Type.ime()` bottom insets as padding on the WebView
  container; verify that the composer stays above the keyboard.
- Request microphone and location only after a visitor gesture. Check the
  request origin against the exact guide origin, restrict microphone grants to
  `RESOURCE_AUDIO_CAPTURE`, and pass OS permission results back to WebView.
  Denial must leave text answers usable.
- Test renderer recovery, keyboard insets, font scale 1.3 and 2.0, and external
  App Links on a device or emulator. Set `webView.settings.textZoom` only after
  checking the host's font-scale policy and verifying the composer and actions
  remain usable at both scales.

## React Native — `react-native-webview`

Use a single `WebView` for Ask with the canonical URL, JavaScript and DOM
storage enabled. Keep it mounted while other tabs are selected. Use
`onShouldStartLoadWithRequest` to police only the top frame, allow
`about:blank`/`about:srcdoc`, retain same-origin navigation, and send allowed
external actions to React Native `Linking`. `onOpenWindow` is a secondary
handler for `_blank`; Android should keep `setSupportMultipleWindows(false)`.

Apply the app background color to the WebView host, WebView, native safe area,
and tab chrome. Set `allowsBackForwardNavigationGestures={false}` so native
navigation owns history. Recover a terminated iOS content process with
`onContentProcessDidTerminate`; replace a crashed Android renderer by changing
the WebView key in `onRenderProcessGone`. When Ask is hidden, remove its subtree
from VoiceOver and TalkBack as well as setting opacity and pointer events.

The isolated proof shell in `tools/distribution-harness/expo-shell/` implements
these host-side requirements. Set `EXPO_PUBLIC_TORCHIKO_APP_URL` to a seeded
local `/app/<slug>` route for route proof, and
`EXPO_PUBLIC_TORCHIKO_APP_BACKGROUND` to the operator readback value. Its
synthetic `/dev-fixtures/visitor-chat` mode proves layout only and must be
reported as `fixture`, not `real-route`. The shell is a proof aid, not an SDK or
release app.

## Flutter — `webview_flutter`

Load the canonical URL in one persistent `WebViewWidget`; enable JavaScript and
DOM storage. Keep that same controller attached while Ask is hidden. Use
`NavigationDelegate` for same-origin policy and route off-origin, `tel:`, and
map URLs through an explicit platform URL launcher. Handle popup/new-window
requests through the platform WebView delegates or an equivalent host hook, and
verify a real action link. Apply the app background before first load; keep the
WebView above tabs and safe areas. Test keyboard resize, text scaling,
geolocation/microphone permission behavior, renderer recovery, and load-failure
retry on both platforms.

## Reference implementation status

The Swift and Kotlin reference sources in the architecture packet are examples,
not a supported SDK. They have not been compiled on this Windows host or
verified on a device. The Expo shell has passed Expo Doctor and JS/Metro export;
native/device status is tracked in the RC-1 QA evidence index. Do not describe
unverified snippets or behaviors as production-tested.
