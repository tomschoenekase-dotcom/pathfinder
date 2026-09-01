# Torchiko staging dashboard public-asset evidence — 2026-09-01

## Scope and release identity

This evidence covers the unauthenticated public sign-in boundary of the Railway staging dashboard only. It is tied to deployed application revision `723ecc583a57ac79e56489f4a9a5865cb946d505` by the same fail-closed hosted health contract used by the release verifier. The existing staging topology evidence identifies dashboard deployment `e2e198a1-84b1-4c5e-8b88-1b9d84ef0688` and immutable image digest `sha256:49b2882ab1880098f17774ca1da3c171762901cecfdeb3cdedaad1f200254e47`; see [the current staging truth](./TORCHIKO_STAGING_CURRENT_TRUTH_2026-09-01.md).

The measurement implementation was introduced at `590b2a5aa6273065d91a05e7c05225484a487987`, indexed at `e001bf6f1f47e8648ae33074b38be88fbe4a9aa4`, and its failure gates were directly unit-tested at `2d5ba43eb61280f5736e5bb207f24682d0434dca`.

## Method

The operator ran:

```text
pnpm dashboard:hosted-assets --revision 723ecc583a57ac79e56489f4a9a5865cb946d505 --samples 3
```

The command first requires the public web health endpoint to prove the exact requested staging revision and reviewed resource identities. It then opens the dashboard origin in three fresh, headless Chromium contexts with no stored authentication or customer state, service workers blocked, a 1440 by 1000 viewport, and reduced motion enabled. It accepts only the exact HTTPS host from the release policy, requires every navigation to end at `/sign-in`, fails on browser errors, and requires non-zero same-origin and script transfer evidence. Browser error content is fingerprinted rather than retained.

The ignored local report is `artifacts/hosted-dashboard-assets/723ecc583a57ac79e56489f4a9a5865cb946d505.json`, generated at `2026-09-01T16:19:39.989Z`. Its SHA-256 is `1418754CE7CFB6762814EE9BCC2A6B4B9FDE6DE0AFC0C20747B3157A71386147`.

## Results

All three samples reached `/sign-in`, recorded zero browser errors, and made 20 same-origin requests. The representative nearest-rank measurements were:

| Metric               |           p50 |           p95 |
| -------------------- | ------------: | ------------: |
| DOM content loaded   |      1,149 ms |      1,438 ms |
| Load event           |      1,262 ms |      1,548 ms |
| Same-origin transfer | 448,561 bytes | 448,561 bytes |
| Script requests      |             8 |             8 |
| Script transfer      | 223,461 bytes | 223,461 bytes |

The run also observed 12 external resource requests per sample. Their URLs and content were intentionally not retained because they are unnecessary for this evidence.

## Verification

- The focused hosted measurement and golden-smoke test set passed 10/10 after direct tests were added for missing samples, wrong-route navigation, browser errors, and zero-transfer results.
- The dashboard lint and typecheck passed.
- The repository script suite passed 349 of 350 tests with one declared skip and zero failures before the final gate.
- Exact static release verification at `e001bf6f1f47e8648ae33074b38be88fbe4a9aa4` passed 18/18 gates with zero failures or blockers. The JSON report SHA-256 is `35C74C9BDDB42E4DC51D60759FDB397AA05F4590DD68A533B718A61779CB9692`; the Markdown report SHA-256 is `B752FCD3ED7F32166E9BB77544D042C9D7D02AF0AA1519E1DC2F626AA3F8292B`.

The full candidate profile and hosted CI must be run against the final evidence commit; their exact identities belong in the durable AI OS checkpoint rather than being predicted here.

## Honest boundary

This is not an authenticated product-performance result and it is not an SLO. It does not measure authenticated dashboard route chunks or pixels, representative customer history, database-query latency, a physical device, multiple geographies, cache variation, or sustained load. Those parts of PERF-03 remain pending until authorized authenticated and representative data are available. No production environment was selected or changed.

## Current-release refresh

After Railway admitted `a3e66de5a1231aca6df5d150ca7bcd81831dd784`, the same fail-closed command
ran again with three fresh contexts. All samples reached `/sign-in` with zero browser errors. The
nearest-rank results were 1,012/5,084 ms DOM-content-loaded p50/p95, 448,499 same-origin transfer
bytes, and 223,463 script transfer bytes. The p95 reflects one cold 5,084 ms observation and is
retained as measured rather than normalized away.

The ignored report is
`artifacts/hosted-dashboard-assets/a3e66de5a1231aca6df5d150ca7bcd81831dd784.json`; its SHA-256 is
`D3CB9464F97A31D11138A80E79972354F0F7D22D6EDABCC34BB42585A2BA0F6C`. This refresh remains an
unauthenticated public-shell observation, not an SLO or proof of authenticated route/database
performance.
