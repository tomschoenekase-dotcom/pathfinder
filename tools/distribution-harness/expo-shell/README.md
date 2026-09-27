# Expo distribution shell

This isolated Expo app sits outside `apps/*` and `packages/*`; it is not part
of the pnpm workspace or CI install. It has its own `package-lock.json` and a
bottom tab bar for Home, Tickets, Map, and Ask. Ask loads
`EXPO_PUBLIC_TORCHIKO_APP_URL` in one `react-native-webview` with JavaScript and
DOM storage enabled.

The host keeps that WebView mounted while another tab is visible. Conversation
identity/history is scoped to its WebView `sessionStorage`; creating a new
WebView instance starts a new conversation. The shell routes same-origin guide
navigation in the WebView and permitted external links through React Native
`Linking`. It blocks unrecognized schemes, keeps native navigation gestures
off, covers renderer loss, and removes the hidden Ask view from VoiceOver and
TalkBack. Set `EXPO_PUBLIC_TORCHIKO_APP_BACKGROUND` to the venue app background
from operator readback; the shell accepts only `#RRGGBB` and uses the value
before first paint.

## Android emulator

For a real-route secure-context check, start the local production app on
`127.0.0.1:4175`, then forward that local port into the emulator:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:4175 tcp:4175
$env:EXPO_PUBLIC_TORCHIKO_APP_URL = 'http://localhost:4175/app/<A5-seeded-slug>'
$env:EXPO_PUBLIC_TORCHIKO_APP_BACKGROUND = '<operator-readback-hex-color>'
```

Use the exact seeded slug and background in the task-root QA evidence index.
`localhost` is a secure context for geolocation and microphone. The
`http://10.0.2.2:<port>` pattern is not a secure context; when used, it proves
layout only. Do not use a public tunnel.

## iPhone Expo Go

The current Tom handoff uses the synthetic DB-free Next fixture at
`http://<PC-LAN-IP>:3100/dev-fixtures/visitor-chat?...`. It proves layout only
over trusted local Wi-Fi. Plain LAN HTTP has no secure context, so microphone
and geolocation cases are `not-run`; a fixture pass must be reported as
`fixture`, not `real-route`. Staging can provide a later HTTPS `real-route`
run. Do not open a tunnel unless Tom explicitly authorizes it.

Install with `npm ci` in this directory and start the project with
`npx expo start --lan`. The shell is a proof aid, not an app release. Expo SDK
57 uses React Native 0.86 and React 19.2.3; `react-native-webview` is included
as an Expo Go native module.
