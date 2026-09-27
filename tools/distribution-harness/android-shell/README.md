# Android WebView QA shell

This task-owned Kotlin shell is an Android device harness, not a production
Torchiko APK. It loads the real local production `/app` route for synthetic A5
venue `launcher-p7-a5-9cf727d329` over ADB reverse at
`http://localhost:4175/app/launcher-p7-a5-9cf727d329`.

- Shell and WebView background: `#0d1616`.
- Native tabs: Home, Tickets, Map, Ask. Home/Tickets/Map currently display
  labeled shell placeholders; Ask displays the guide WebView.
- The Ask WebView remains attached and invisible on other tabs. Returning to Ask
  preserves an unsent composer draft.
- Main-frame navigation stays inside WebView only for the exact guide origin
  `http://localhost:4175`. Other main-frame URLs are offered to Android's
  external activity resolver; subframe navigation is not intercepted.
- JavaScript, DOM storage, geolocation, and keyboard resize behavior are
  enabled. Location prompts are accepted only for the exact guide origin and
  require Android location permission. Audio requests are limited to
  `RESOURCE_AUDIO_CAPTURE` from that exact origin and require Android
  `RECORD_AUDIO` permission.
- A crashed renderer's WebView is removed and destroyed, then recreated and
  reloaded. The renderer recovery path was source-reviewed but not forced during
  the device run.
- Native dependencies are built with installed Android Build Tools 36.1.0;
  generated project Gradle properties disable SDK downloads.

The synthetic route exposed the location prompt, but this run did not prove a
device location fix. The page has no voice, external URL, or telephone control,
so those route interactions were not run. The Android emulator's IME reported
shown on composer focus but displayed only its side input toolbar, not a full
QWERTY layout. See the external task evidence at
`qa/distribution/android/README.md` for APK hash, logs, screenshots, and the
Expo native build failure/fallback record.
