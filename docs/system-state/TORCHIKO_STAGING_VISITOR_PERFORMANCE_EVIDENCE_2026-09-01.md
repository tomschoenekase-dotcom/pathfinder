# Torchiko staging visitor performance evidence — 2026-09-01

## Outcome

The current Railway staging visitor route now has a durable, exact-release-bound performance measurement rather than console-only Playwright output. The credential-free harness validates staging health and resource identity before opening the real Riverside Aquarium chat route, uses fresh mobile Chromium contexts, sends no chat request, makes no provider call, rejects browser errors and route drift, and writes a machine-readable JSON report inside an ignored artifact directory.

## Exact identities

- Deployed Railway staging application: `723ecc583a57ac79e56489f4a9a5865cb946d505`.
- Measurement implementation: `762d896638f929006372c03cc573c5d4e6650add` (`feat: retain hosted visitor performance evidence`).
- Command: `pnpm visitor:hosted-performance --revision 723ecc583a57ac79e56489f4a9a5865cb946d505 --samples 3`.
- Report: `artifacts/hosted-visitor-performance/723ecc583a57ac79e56489f4a9a5865cb946d505.json`.
- Report SHA-256: `40F4C23EAD82A00743215C31F40EE28A479F3806D394C2B05B0CA672735289BB`.
- Focused measurement/helper tests: 7/7 passed.
- Full script suite after implementation: 353 passed, 0 failed, 1 intentionally skipped (354 total).

## Hosted measurements

Each network profile used three fresh 390×844 mobile Chromium contexts with service workers blocked and reduced motion enabled. Weak 4G means 150 ms emulated latency, 1.6 Mbps download, and 750 Kbps upload.

| Metric                          |                  Unthrottled |               Weak 4G |
| ------------------------------- | ---------------------------: | --------------------: |
| Interaction ready p50           |                     1,764 ms |              4,819 ms |
| Interaction ready p95 / maximum |                     2,052 ms |              5,263 ms |
| DOMContentLoaded p50            |                       930 ms |              1,895 ms |
| Load event p50                  |                     1,108 ms |              4,309 ms |
| Resource transfer               | 799,855 bytes in all samples | 675,008–796,396 bytes |
| Script transfer                 | 577,262 bytes in all samples | 452,415–573,803 bytes |
| Longest long task               |                        73 ms |                 82 ms |
| Browser errors                  |                            0 |                     0 |
| Chat requests / provider calls  |                        0 / 0 |                 0 / 0 |

These observations replace the stale-release baseline for the currently deployed application. They are retained measurements, not an invented SLO.

## Remaining PERF-01 boundary

This closes the durable current-release public visitor-shell measurement gap. It does not close PERF-01: physical iPhone/Android CPU and real-radio evidence, approved-media loading, and one founder-approved spend-bounded provider-backed staging turn for real time-to-first-token and total-answer timing remain pending. No customer state, authenticated session, production environment, marketing site, branding, or Tochi asset was used or changed.

## Current-release refresh

The same credential-free harness ran after Railway admitted exact release
`a3e66de5a1231aca6df5d150ca7bcd81831dd784`. Six fresh 390×844 Chromium contexts passed with zero
browser errors, chat requests, or provider calls. Interaction-ready p50/p95 was 1,857/2,128 ms
unthrottled and 4,804/4,812 ms under the declared weak-4G profile. The ignored report is
`artifacts/hosted-visitor-performance/a3e66de5a1231aca6df5d150ca7bcd81831dd784.json`; its SHA-256 is
`20FBF15DF97AB648781B44F4AB82A4B8FE530C334729D93BE42C9E9D38EDDECF`.

This supersedes `723ecc58` only as the current-release measurement. The older report remains valid
historical evidence. The physical-device, real-radio, approved-media, and provider-backed TTFT
boundaries remain open.
