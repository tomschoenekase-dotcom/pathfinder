# Visitor chat keyboard and composer: model, evidence and real-device protocol

**Status (2026-10-02):** implemented; unit and Chromium emulation tests pass. **Real iPhone Safari and Chrome
verification: NOT RUN.** Do not call the regression fixed, or the build production-ready, until the record at the
end of this file has been completed on real iPhones with the exact candidate build. Desktop emulation, Playwright
and `visualViewport` overrides exercise the logic, not the iOS keyboard.

## Required interaction (owner direction, 2026-10-01/02)

1. Normal page: composer at the bottom of the chat, conversation reachable.
2. Tap the composer: the keyboard opens; the composer sits directly above the keyboard / input accessory bar with
   recent conversation visible. No manual "rescue" scroll.
3. Type: short or multiline text stays legible and scrolls inside the field.
4. Submit a valid message: the draft enters the normal send lifecycle, the software keyboard is dismissed in the
   same interaction and the composer settles back to the bottom — without waiting for the AI response.
5. While the answer loads/streams nothing refocuses the composer or reopens the keyboard.
6. Tap again: the same layout every cycle, through browser chrome changes.

## Evidence before the fix

- `IMG_0341.png` (Safari, iPhone): keyboard open, a large blank dark band at the top, the venue title displaced down
  next to the keyboard accessory bar; composer not visible above the keyboard.
- `IMG_0342.jpeg` (Safari, iPhone): the composer hint "Ask anything about this place..." wraps onto a second line
  that the one-line field clips, leaving the tops of the second line's letters as stray strokes.

## Causal explanation

**Blank band / displaced shell.** The previous `useChatViewportHeight` (commit 55c3bb6) pinned the
`position: fixed` shell to `top = visualViewport.offsetTop`, which is correct by specification. It then "verified" the
result by comparing `shell.getBoundingClientRect().top` with `offsetTop` and adding the difference. Browsers disagree
on the coordinate frame of a fixed element's client rect: Chromium reports it relative to the layout viewport, while
iOS WebKit reports it relative to the **visual** viewport (independently reported by WebView/iOS projects, e.g.
golem-fail/golem#238: "fixed elements track the VISUAL viewport on iOS"; their fix also removed a double subtraction
of the visual viewport offset). On an iPhone a correctly placed shell therefore measures `top = 0` while
`offsetTop = P` (the pan), the hook read a residual of `P` and moved the shell down by `P` a second time, after which
the measurement "agreed" (`P − P = 0`) and it stopped. Result: the shell sits one pan-height below the visible top —
blank band above, header and composer pushed onto/under the keyboard. That matches IMG_0341. Chromium-based emulation
and the earlier Playwright specs use layout-relative rects, so they could not reproduce it. The earlier version
(`top = offsetTop − scrollY`) failed in the opposite direction. Manual scrolling changes `offsetTop` and so appeared to
"rescue" the layout.

**Clipped hint.** The textarea is one line tall (44px, 24px line box) beside the voice and send controls. WebKit lays
out a textarea `placeholder` as wrapping block text, so at phone widths the hint wrapped and its second line was
clipped by the field. The autosize effect does not count placeholder text, so the field never grew to fit it.

These are code-level explanations consistent with the screenshots. They have not been measured on the reporting
device; the debug overlay below exists to confirm them.

## The model now (one owner of geometry)

`apps/web/hooks/useChatViewportHeight.ts`: **the shell is the visual viewport.** On every visual-viewport
`resize`/`scroll` (plus `pageshow`, `visibilitychange`, `orientationchange`, focus changes) the shell's inline
`top/left/height` are read straight from `visualViewport.offsetTop/offsetLeft/height`
(`data-viewport-pinned`, `--chat-viewport-offset-*`). When the visual viewport equals the layout viewport the
stylesheet default (`position: fixed; inset: 0`) applies. Nothing else compensates for the keyboard.

Removed or not used, deliberately:

- the measured alignment/correction loop (the cause above) and its commit-wait/stop heuristics;
- any `scrollY` term in the position arithmetic;
- document scrolling while a field is focused (Safari's own reveal scroll is never fought);
- keyboard padding, transforms or extra offsets compensating for the same space.

Kept, with one purpose each:

- `data-keyboard-open` (editing and the visual viewport is ≥80px below a stable baseline): styling only — compact
  header, hidden footer, capped textarea height — and the dismiss-on-send decision. The baseline is the largest
  unzoomed visual-viewport height seen while not editing, reset on orientation change, because recent iOS shrinks
  `innerHeight` with the keyboard.
- After focus leaves and the viewport is back near baseline, leftover document scroll is released with
  `scrollTo(0, 0)`. The rectangle is followed even when not editing, so a pan iOS leaves behind after the keyboard
  closes (reported for iOS 26, Apple Developer Forums thread 800154) still produces a correctly placed shell.
- Transcript re-pin: if the reader was following the latest message when the height changed, the conversation is
  scrolled to its end after layout; a reader who scrolled up is left alone. Streaming tokens do not force scroll for a
  reader who scrolled up (existing `followLatestRef` in `ChatWindow`).
- Pinch zoom (`scale ≠ 1`) leaves the stylesheet geometry alone; zoom is not disabled.
- Inside an iframe the frame's visual viewport does not see the host keyboard; the hook then leaves the stylesheet
  geometry, and dismiss-on-send falls back to touch-only detection. Host coordination stays out of scope until a real
  host is tested (see app-webview-integration.md).

`apps/web/components/ChatWindow.tsx`:

- Valid submit → `onSend` accepted → draft cleared → if `shouldDismissKeyboardOnSubmit` (shell reports an open
  keyboard, or the device is touch-only: `(hover: none) and (pointer: coarse)` without `(any-pointer: fine)`), the
  textarea is blurred **in the same event handler** and focus restoration after the response is disabled. Desktop and
  iPad-with-trackpad keep focus as before.
- Whitespace-only, IME composition (`isComposing`, or Safari's Enter `keyCode 229`), and parent-rejected sends neither
  submit nor dismiss; the draft is kept. Failed sends keep the existing retry with stable send identity.
- The empty hint is a composer-drawn, `aria-hidden` single line (`white-space: nowrap; text-overflow: ellipsis`)
  in the textarea's first line box; the textarea carries `aria-placeholder` so it is still announced. No overflow is
  hidden on the composer as a whole and the placeholder text is unchanged.

`apps/web/app/layout.tsx`: the hand-written viewport `<meta>` was replaced with the Next.js `viewport` export, so each
page has exactly one viewport tag (previously two). Zoom is not restricted.

## References used

- MDN, VisualViewport — https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport (offsets are relative to the
  layout viewport; only the top-level window has an independent visual viewport).
- WICG visual-viewport `examples/fixed-to-keyboard.html` — positions a fixed bar from `innerHeight`, `height` and
  `offsetTop` of the visual viewport; no measurement loop. Principle adapted; no code copied (no licence stated).
- Chrome for Developers, viewport resize behaviour — https://developer.chrome.com/blog/viewport-resize-behavior
  (Chrome Android defaults to `resizes-visual`, consistent with this model; not used as iOS evidence).
- golem-fail/golem PR 238 and s3ntin3l8/mullion-session-manager PR 1398 (independent reports of iOS fixed-element
  rects in visual-viewport coordinates, and of tracking the pan offset separately).
- Apple Developer Forums 800154 (iOS 26 `offsetTop` not returning to 0 after keyboard dismissal).

## On-device geometry readout

Open the guide with `?debugViewport=1`. A green overlay shows geometry only (no message text, nothing sent):

- `rect-frame`: `visual` (iOS WebKit) or `layout` (Chromium) — which frame this browser uses for fixed rects.
- `residual`: shell top minus the visible top in that frame. **Expected 0 (±1)** with the keyboard open.
- `gap-above-keyboard`: space between the composer bottom and the keyboard. **Expected small (≈8–16).**
- `vv.height`, `vv.offsetTop`, `vv.scale`, `innerHeight`, `scrollY`, `pinned`, `keyboard-open`.

Screenshot the overlay at: before focus, keyboard settled, immediately after send, keyboard closed, refocus.

## Automated evidence (2026-10-02, local container, Chromium only)

- `apps/web`: `npx vitest run` — 70 files, 538 tests PASS (includes 16 hook tests: iOS visual-frame rects
  are never measured; iOS 26 leftover pan; 10 cycles without drift; pinch zoom; orientation; listener cleanup; dismiss
  decision; and 5 ChatWindow tests: dismiss on Enter and on tap, no refocus after answer, whitespace/IME/rejected send
  keep keyboard and draft, desktop keeps focus, single-line hint).
- Playwright `visitor-chat.spec.ts` keyboard/composer specs on android-320/390 and desktop-1440 Chromium: 20 PASS,
  1 skipped (phone-only spec on desktop). Includes the new "valid send dismisses the keyboard" and "hint is one clean
  line at 320px" specs. Playwright WebKit was **NOT RUN** (browser not installed in this container). Both use
  `visualViewport` overrides, not a real keyboard.

## Real-iPhone record (complete one per browser; required to pass A29 / M01–M05)

Candidate SHA/build:
URL (standalone / embed / WebView):
Venue fixture and content version:
Date/time, tester:
Device, iOS version, browser + version:
Text size and toolbar state:
Evidence path (screen recording + overlay screenshots):

| #   | Step                                                                                                       | Safari  | Chrome  |
| --- | ---------------------------------------------------------------------------------------------------------- | ------- | ------- |
| 1   | Fresh load: normal chat, composer at bottom, hint on one clean line                                        | NOT RUN | NOT RUN |
| 2   | Tap composer: composer directly above keyboard, recent messages visible, residual 0, small gap, no rescue  | NOT RUN | NOT RUN |
| 3   | Type short, then multiline; caret visible; field scrolls internally                                        | NOT RUN | NOT RUN |
| 4   | Send (Return key and send button): keyboard closes during the tap, composer returns down before the answer | NOT RUN | NOT RUN |
| 5   | While streaming: no refocus, no keyboard reopen; scroll up to read — not dragged down                      | NOT RUN | NOT RUN |
| 6   | Ten focus/type/send/refocus cycles: identical geometry, no drift, no blank band                            | NOT RUN | NOT RUN |
| 7   | Close keyboard by hand (swipe/Done) and reopen; toolbar collapse/expand; background and return             | NOT RUN | NOT RUN |
| 8   | Long conversation; rotate portrait↔landscape; larger text size; pinch zoom then focus                      | NOT RUN | NOT RUN |
| 9   | Whitespace-only and IME (e.g. Japanese) entry: no send, keyboard and draft kept                            | NOT RUN | NOT RUN |
| 10  | Airplane mode after send: honest error, draft recoverable, retry sends once, no forced keyboard            | NOT RUN | NOT RUN |
| 11  | Embedded website / WebView host, if offered to a customer                                                  | NOT RUN | NOT RUN |

Browser-native toolbars and the input accessory bar are allowed. A blank band, a composer under the keyboard, a
manual rescue scroll, a wrapped/clipped hint or a keyboard reopening by itself is a FAIL.
