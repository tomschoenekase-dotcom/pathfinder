# Packet 14 M5 evidence checklist

Status at pinned R1.1 base `512df5d4329ac4842b1c5e3cb9ea6cd92710d324`; this note records local synthetic evidence and remaining gates. It does not claim three consecutive M4 runs or an exact R2 result.

## Summary

| Owning proof                                    | Status                                                          | What this packet can establish                                                                                                                                                                                                                                   | Remaining gate                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packet 2 milestone B, local full-stack phases   | **Local synthetic phase table captured; milestone B partial**   | A disposable DB read-only report captures 7 first and 8 follow-up Aurora turns with per-phase median/p90. A browser smoke run passed two turns at both widths, 76 NDJSON deltas per turn, at least three distinct painted word counts, and retained screenshots. | These are synthetic stub timings, not staging or live-provider speed. M4 needs three consecutive full runs on exact R2.                                                                                                                                        |
| Client portal states                            | **Narrow fixture journey passed; broader portal proof pending** | The tenant A Look & feel save, preview and public guide persistence plus tenant B isolation passed locally at both widths.                                                                                                                                       | Home intake, Help, Updates, Account/billing, upload and real Clerk remain outside this narrow run; do not promote it as the full portal handoff proof.                                                                                                         |
| Packet 7 CRM Good fit and visitor speed screens | **Blocked on Packet 12 R2**                                     | The M4 spec contains the intended admin navigation and assertions for both screens.                                                                                                                                                                              | The test explicitly skips unless `TORCHIKO_PACKET12_R2_SHA` is set; R1.1 does not contain these surfaces. Rebase/integrate the announced R2, then run the test against that exact tree and record its SHA and artifacts. No live CRM read or write is covered. |

## Reproduction and evidence capture

From the repository root, with Docker available and no real service credentials. On Windows PowerShell, set the two Playwright variables before running the test so its visual config reuses the Packet 14 stack:

```powershell
pnpm local:reset
pnpm local:up
node --test scripts/local-provider-stub.test.mjs
node --test scripts/local-fixture-auth-config.test.mjs
pnpm --dir packages/auth exec vitest run src/local-fixture/guard.test.ts src/local-fixture/edge.test.ts
node scripts/local-full-stack-network-proof.mjs
$env:PLAYWRIGHT_DASHBOARD_BASE_URL='http://127.0.0.1:56346'
$env:PLAYWRIGHT_VISITOR_BASE_URL='http://127.0.0.1:56345'
pnpm --dir apps/dashboard exec playwright test --config playwright.visual.config.ts tests/visual/local-full-stack.spec.ts --project phone-390x844
Get-Content qa/packet-14-local-phase-report.sql -Raw | docker exec -i nC-postgres psql -X -v ON_ERROR_STOP=1 -U pathfinder -d pathfinder_disposable_p14_local > C:/Users/tomsc/MachineWorkspaces/torchiko/20260928-local-full-stack/proof/phase-report.txt
pnpm local:down
```

The Playwright project `phone-390x844` deliberately runs each journey at both 390×844 and 1440×900; the other configured projects skip these tests. Keep the Playwright JSON attachments, screenshots, run summary, disposable phase report and exact checkout SHA with the evidence. M6's opt-in workflow is intended to run the journey three consecutive times and execute `local:down` even after a prior failure.

The stack reached ready after all 252 migrations and its synthetic seed; provider/web/dashboard health returned 200. The host-process network proof found zero established non-loopback connections among five attributed PIDs at the audit point and denied a synthetic TEST-NET-3 request before socket creation. Provider tests passed **10/10**, fixture auth tests **8/8**, and one combined browser invocation passed the three non-admin journeys in about one minute (3 pass, 1 explicit R2 admin skip). The read-only R1.1 phase report is retained under the Packet 14 owner `proof/r1-phase-report-20260928.txt`; it includes first/follow-up medians and p90 for each phase. Three consecutive full M4 runs on exact R2 are still pending.

## Owning packet acceptance wording

- **Packet 2:** the local portion of acceptance 4 has a synthetic phase table and a real local browser paint capture. The Aurora report has 7 first turns (request-first-text median 1,371 ms, p90 2,546 ms) and 8 follow-up turns (median 608 ms, p90 1,434 ms). The browser smoke recorded over 40 words and at least three distinct rAF paint samples per turn at both widths. These results do not establish hosted first-message/follow-up performance or live-provider latency; those remain behind Packet 1 G2 and explicit live-turn authorization.
- **Portal handoff:** its screens and prior visual/journey evidence were explicitly development fixtures with an in-memory client, no Clerk session, and sessionStorage persistence in the Look & feel flow. Those prior branch results do not become a Packet 14 exact-head run by reference. This packet's fixture auth verifies a local role/tenant path; it does not exercise real Clerk authentication, production preview access, uploads to real storage, malware scanning, billing, or real Help threads.
- **Packet 7:** its handoff records that authenticated post-upload CRM states were unverified and that the Good fit review screen belongs to Packet 12 R2. Packet 14's admin test has a visible skip for the missing R2 surfaces. Passing the test with that case skipped cannot close the Packet 7 review-screen proof.

## Safety and scope

The M4 browser test blocks requests outside its explicit loopback origin allow-list and asserts no browser request to an external origin was attempted. The host-side preloader blocks non-loopback calls, and a live socket audit covered the attributed provider and Next processes at one point in time. The Docker host-facing proxy's raw outbound route is not hard blocked by this Compose setup; this boundary remains partial and is recorded on the lane board. The auth identity is synthetic and local. Packet 14 acceptance does not authorize staging/production turns, hosted CRM reads, writes, deployments, or changes to the other packets' branches.
