# Visitor chat keyboard: real-device verification protocol

Status of the fix: code and automated tests are done; **real iPhone Safari and Chrome evidence is NOT RUN.** Do not call the
regression fixed or the build production-ready until the matrix below is filled in from real devices on the final build.
Desktop emulation, Playwright WebKit and `visualViewport` overrides prove the logic, not the iOS keyboard.

## What changed and why

Probable cause of the regression (from the screenshots and the code; not yet measured on a device):
`useChatViewportHeight` pinned a `position: fixed` shell with `top = offsetTop - scrollY`. `position: fixed` is placed in
layout-viewport coordinates and `visualViewport.offsetTop` is also measured from the layout viewport's top edge, so
subtracting `scrollY` double-counts whatever document scroll iOS applies to reveal the focused field (the fix deliberately
stopped fighting that scroll). The shell sat too high by exactly that scroll: composer clipped at the top, a blank band above
the keyboard. Scrolling by hand changes `scrollY` and `offsetTop` together, which is why it reached the intended layout.

Now (`apps/web/hooks/useChatViewportHeight.ts`): one viewport owner. The shell is pinned to the visual viewport rectangle
(`top = offsetTop`, `height = viewport.height`) with no scroll term. Each viewport event is followed by a bounded check of
the measured shell position against the visual viewport (at most 3 corrections, only while each correction demonstrably
moves the shell; otherwise the plain geometry is restored). A transcript that was following the latest message is re-pinned
to its end when the viewport changes height, so recent conversation stays visible above the composer. Closing the keyboard
returns the shell to the full layout viewport. No hard-coded pixel offsets, no forced blur on send.

Files: `apps/web/hooks/useChatViewportHeight.ts` (+ `.test.tsx`), `apps/web/components/ChatWindow.tsx`
(`data-chat-conversation` marker), `apps/web/components/ViewportDebugOverlay.tsx` (two new readouts).

## How to capture numbers on a device

Open the guide with `?debugViewport=1` (for example `https://guide.torchiko.com/<venue>/chat?debugViewport=1`). A green overlay
shows live geometry and sends nothing anywhere. The two numbers that decide the result:

- `residual` = visual viewport top minus the shell's top. **Expected 0** (within 1) once the keyboard is open and settled.
- `gap-above-keyboard` = empty space between the composer's bottom edge and the keyboard. **Expected small** (about the
  composer's own bottom padding, roughly 8 to 16). A large value is the "huge blank gap" failure.

Also record `vv.height`, `vv.offsetTop`, `scrollY`, `innerHeight`, `offset-var`, and a screenshot with the keyboard open.

## Matrix (fill in; one row per device and browser)

Run each browser separately; do not assume they behave alike. Use the final build under test (record its exact revision).

| Step                                                                                                            | iPhone Safari | iPhone Chrome |
| --------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| Device / iOS version                                                                                            |               |               |
| Build revision                                                                                                  |               |               |
| 1. Open guide, do not touch the page, tap the input                                                             |               |               |
| 2. Keyboard open: composer sits directly above the keyboard (gap and residual per above)                        |               |               |
| 3. Recent messages visible above the composer; no manual scroll needed                                          |               |               |
| 4. Type and send; reply streams in; composer stays above the keyboard                                           |               |               |
| 5. Dismiss the keyboard (tap outside / Done): composer returns to the bottom, transcript at a sensible position |               |               |
| 6. Repeat focus / send / dismiss 5 times: values identical each open (no cumulative drift)                      |               |               |
| 7. Rotate to landscape and back with the keyboard closed, then open again                                       |               |               |
| 8. Pinch zoom, then focus: no jump, no stuck state                                                              |               |               |
| 9. Safari only: scroll the page by hand with the keyboard open; layout stays correct                            |               |               |
| 10. Chrome only: behavior is at least as good as the last known-good build                                      |               |               |

Result values: PASS / FAIL / NOT RUN. Attach the overlay readout and a screenshot for steps 2, 4 and 5.
Native Safari browser chrome and the input accessory bar are allowed in the target layout.

## Automated evidence (local)

- `hooks/useChatViewportHeight.test.tsx`: no scroll term, measured alignment and stop condition, non-responsive
  measurement is not chased, transcript re-pin and reader left alone, 6 open/dismiss cycles identical, orientation baseline.
- Playwright keyboard specs in Chromium and WebKit (`apps/dashboard/tests/visitor-launch/visitor-chat.spec.ts`).
  Both override `visualViewport` values; they are not an iOS keyboard.
