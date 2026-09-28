# Add Torchiko to your app

Put the same Torchiko venue guide in an Ask tab or screen of your app. The quick path is a WebView that loads one URL. It needs no Torchiko API key, customer secret, cookie injection, or chat integration.

## Get the app URL first

Ask Torchiko for your venue's **exact app URL** and **app background color**. Torchiko must enable app access for your venue before the URL works. Use its supplied `https://.../app/YOUR-VENUE-SLUG?header=none` URL as the WebView's top-level page. `header=none` lets your native screen own the title and Close button; use `header=compact` if you want a small Torchiko header too.

For a starting question, append `&ask=Where%20is%20the%20entrance%3F` to the supplied `header=none` URL. It fills the composer but **never sends** until the visitor taps Send. Limit the decoded question to 200 characters and URL-encode it. If Torchiko gives you a public place ID for this venue, you may append `&place=PUBLIC-PLACE-ID`; other IDs are ignored. Neither parameter changes access.

## Ten-minute WebView path

Use your app's WebView to load the exact URL. Keep that WebView mounted when the visitor switches tabs; replacing it starts a new conversation. Put it inside the device safe area and above native tabs. Set the view and its container to Torchiko's supplied background color before the first load, and provide a native Close button. Allow JavaScript and first-party browser storage. Send off-site HTTPS links, phone, mail, and map actions to the operating system. Keep unknown URL schemes blocked. Show a Retry control if the top-level guide fails to load.

The guide can send `{ "source": "torchiko", "v": 1, "type": "close-requested" }` when a visitor asks to close it. Only honor a well-formed message from the known Torchiko guide URL or message handler, then return to your app screen. The full [host bridge contract](host-bridge.md) covers this message. No message contains visitor questions or answers.

### iOS: Swift / `WKWebView`

Create a `WKWebView` with the default persistent data store. Load the exact supplied URL, set `isOpaque = false`, and set the WebView and scroll view backgrounds before loading. Constrain it to the safe area. Add a native Close button. Register a `WKScriptMessageHandler` named `torchiko` for `close-requested`, and check the main frame plus the exact guide origin before acting. The [Swift reference file](../../tools/distribution-harness/native-snippets/TorchikoGuideViewController.swift) shows the starting wiring; it is reference code, so compile and device-test it in your app before release. Use `WKNavigationDelegate` to send allowed external actions to the OS. The detailed [app host guide](app-webview-host-guide.md) covers link, keyboard, microphone, and recovery handling.

### Android: Kotlin / `WebView`

Enable JavaScript and DOM storage, set the WebView background before `loadUrl`, and load the exact supplied URL. Keep the view mounted through tab switches. Add a native Close button and use `WebViewClient` to keep same-origin HTTPS navigation inside the guide. Open allowed external HTTPS, phone, mail, and map links through `ACTION_VIEW`; reject unknown schemes. Add the AndroidX WebKit `androidx.webkit:webkit` dependency to use the origin-scoped `WebViewCompat` message listener for `close-requested`. The [Kotlin reference file](../../tools/distribution-harness/native-snippets/TorchikoGuideActivity.kt) shows that wiring. It is reference code, so compile and emulator-test it in your app before release. The detailed [app host guide](app-webview-host-guide.md) covers keyboard insets, permissions, and renderer recovery.

### React Native: `react-native-webview`

Place one `WebView` in your Ask tab and keep it mounted when another tab is selected. Paste the supplied app URL and background into this minimal wiring, then add your app's Close button and navigation policy:

```jsx
import { WebView } from 'react-native-webview'

;<WebView
  source={{ uri: 'https://YOUR-TORCHIKO-ORIGIN/app/YOUR-VENUE-SLUG?header=none' }}
  style={{ flex: 1, backgroundColor: '#YOUR-HEX-COLOR' }}
  javaScriptEnabled
  domStorageEnabled
  onMessage={({ nativeEvent }) => {
    try {
      const message = JSON.parse(nativeEvent.data)
      if (
        new URL(nativeEvent.url).origin === 'https://YOUR-TORCHIKO-ORIGIN' &&
        message.source === 'torchiko' &&
        message.v === 1 &&
        message.type === 'close-requested'
      ) {
        // Select your app's prior tab or close the Ask screen here.
      }
    } catch {}
  }}
/>
```

Replace every placeholder, including `#YOUR-HEX-COLOR`, with Torchiko's supplied values. Add the external-link allowlist, safe-area layout, keyboard behavior, and retry described in the [app host guide](app-webview-host-guide.md). The [Expo proof shell](../../tools/distribution-harness/expo-shell/README.md) demonstrates a longer-lived Ask tab; it is a test host, not a release SDK.

### Flutter: `webview_flutter`

Create one `WebViewController`, enable unrestricted JavaScript, set the background to the supplied color, and load the exact supplied URL. Keep its `WebViewWidget` and controller alive through tab changes. Add a native Close button and a `NavigationDelegate` that keeps the guide origin inside the WebView and hands allowed external links to your URL launcher. Handle popup/new-window links through the platform hook. The [app host guide](app-webview-host-guide.md) lists the permission, keyboard, and recovery checks required before release.

## Test before release

- Confirm Torchiko has enabled this venue's app access and that the exact supplied URL loads on a physical device or emulator. An unavailable screen is not evidence of access.
- Open Ask, switch to another tab, and return. The same conversation should still be there until the app/WebView is recreated.
- Test native Close, a guide `close-requested` action if shown, keyboard and safe-area fit, load failure and Retry, and an external action link.
- Test a starting `ask`: the question should be visible but no turn sent. Test text chat with microphone access denied; it should remain usable.
- Check phone text scaling and screen-reader focus. If your app offers voice or location, request OS and WebView permissions only after the visitor acts.

The native reference files and Expo shell have not been verified as production app integrations. Test your own host on its target devices. Torchiko's website and app access are separate; an allowed website origin does not enable an app WebView.
