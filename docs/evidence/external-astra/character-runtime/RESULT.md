# Character runtime failure isolation — result

Status: bounded implementation verified; ready for root review. The package-wide web typecheck remains an explicitly unpassed environment/baseline gate. No merge, push, deployment, activation, or final-art approval is claimed.

## Identity and isolation

- Starting commit: `14be680d5171e2a84dfb2b892167c265f98aac0b`.
- Branch: `astra/p07-character-runtime-resilience-20260909`.
- Isolated checkout: `C:/Users/tomsc/Downloads/AwesomeVault/95 AI Staging/Torchiko Character Runtime 2026-09-09/worktree`.
- Ending implementation tree, before adding this report: `89b3768e426acc7eff5e717ed95d10b66d0e54be`.
- The final containing commit SHA, final full tree SHA, binary patch SHA-256, one-commit count, patch round-trip check, and clean-status read-back are recorded after commit in `artifacts/ui-proof/character-runtime-20260909-2306/FINALIZATION.json`. This report is included in that same commit rather than introducing a second documentation commit.
- Evidence root, abbreviated **E** below: `artifacts/ui-proof/character-runtime-20260909-2306`.

The initial worktree HEAD matched the exact frozen commit and its status was empty. All nine packet product SHA-256 values matched bytes from `git show COMMIT:path`; see `E/baseline.json`. The active source checkout had advanced, but was not rebased, edited, built, tested, reset, or cleaned. No repository AGENTS.md was present at the frozen commit; the vault AGENTS.md and frontend design standard were read. No historical vault hash was treated as a live-workspace lock.

## Implemented behavior

`FamilyRigRenderer` now uses fixed-array JSON encoding for source, fallback, and ordered role/source tuples. React layer keys additionally include position, so both formerly ambiguous strings and repeated identical layers have distinct keys. No hashing dependency or shared contract change was added.

A keyed internal scope owns a single failure stage and lifecycle record, not a map of every visited configuration. Identity changes discard the old scope; returning to an earlier identity retries its assets. The sequence is monotonic: healthy → static fallback → neutral T. The stage advances synchronously before parent notification, suppressing duplicate, batched, reentrant, and late lower-stage errors. Layout-effect cleanup makes captured source, layer, and fallback callbacks inert after their scope is retired, including A → B → A revisits. The current parent receives at most one notification per stage.

`VenueCharacterStage` has a keyed scope identified by `[characterId, assetPackId, assetPackVersion]`. A replacement is healthy in its first committed render, without waiting for a passive reset. Retired callbacks are fenced, and the current callback is stable across semantic updates. The exact existing failure status remains: **Character display unavailable; text chat is ready**. The surrounding stage, semantic text, decorative character behavior, explicit reduced motion, and system reduced motion remain intact.

The existing development-only family-rig fixture was extended, not replaced. Its optional `proof=isolation` controls exercise the real renderer using the same neutral Owl, Astronaut, and Morph source bytes. Delayed HTTP failures are fulfilled locally by Playwright; replacement data URLs change identity without changing artwork. Fixture error counters do not implement a substitute failure fence.

## Exact implementation/proof files

1. `packages/ui/src/character/FamilyRigRenderer.tsx`
2. `packages/ui/src/character/FamilyRigRenderer.test.tsx`
3. `apps/web/components/VenueCharacterStage.tsx`
4. `apps/web/components/VenueCharacterStage.test.tsx`
5. `apps/web/components/FamilyRigRenderer.runtime.test.tsx` — the one additional test file. It uses web's existing jsdom/testing-library dependencies to render the actual UI component, without adding dependencies.
6. `apps/dashboard/app/dev-fixtures/character-family-rigs/CharacterFamilyRigGrid.tsx`
7. `apps/dashboard/app/dev-fixtures/character-family-rigs/page.tsx`
8. `apps/dashboard/tests/visual/character-family-rigs.spec.ts`
9. This `docs/evidence/external-astra/character-runtime/RESULT.md`.

Ending SHA-256 values for the two production files are `9cf118801e09c96c7e6111a26df9fa8663b383c63a0147e1ab09ac79e6631b99` and `0a1f8685fefa7dad59477c5863f714b4f8ea59f0ccc6ddfadf72ab9b11e4ccfb`, respectively. All eight implementation/proof hashes are in `E/implementation-tree.json`.

`PublicCharacterPresence`, `StaticCharacterFallback`, CSS, schemas, shared contracts, manifests, registries, source SVGs, branding, routers, workers, and provider code were not edited. Next.js automatically adjusted the isolated dashboard's tsconfig and next-env type file during startup; both were restored byte-for-byte from pre-start copies after shutdown. Their pre-start content was checked against the frozen Git baseline. See `E/next-config-restoration.json`. Neither adjustment is included in the patch.

## Unit and static checks

Toolchain: Node `24.12.0`, Corepack-selected pnpm `9.15.4`, Vitest `3.2.6`, TypeScript `5.9.3`. Bare pnpm was a different version, so checks used Corepack. `corepack pnpm install --frozen-lockfile --offline --ignore-scripts` reused 874 cached packages, downloaded zero packages, and finished in 24.9 seconds. No dependency or lockfile change was made.

The exact argument vectors, exit codes, durations, and log paths are in `E/final-checks.json`. Durations below include command-launch overhead unless stated otherwise.

| Check                                                                                                                                | Result                                                               |  Duration |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------: |
| `corepack pnpm exec prettier --check` over all eight implementation/proof files                                                      | Pass                                                                 |    0.69 s |
| `corepack pnpm --dir packages/ui exec vitest run src/character/FamilyRigRenderer.test.tsx`                                           | 7/7 pass                                                             |    1.61 s |
| `corepack pnpm --dir apps/web exec vitest run components/VenueCharacterStage.test.tsx components/FamilyRigRenderer.runtime.test.tsx` | 19/19 pass                                                           |    3.87 s |
| `corepack pnpm --dir packages/ui typecheck`                                                                                          | Pass                                                                 |    1.37 s |
| `corepack pnpm --dir apps/web typecheck`                                                                                             | Fail: 1,480 unchanged diagnostics; see limitation below              |    7.47 s |
| `corepack pnpm --dir packages/ui lint`                                                                                               | Pass, no warnings                                                    |    2.72 s |
| `corepack pnpm --dir apps/web lint`                                                                                                  | Pass, no warnings                                                    |    5.56 s |
| Focused dashboard ESLint over the two fixture files and visual spec                                                                  | Pass, no warnings                                                    |    3.11 s |
| `node E/scoped-typecheck.cjs`                                                                                                        | Zero diagnostics for all owned files and their actual import closure |    2.14 s |
| `git diff --check`                                                                                                                   | Pass                                                                 | Not timed |

The scoped typecheck uses unmodified web compiler options, explicit owned root files, the existing Next type declarations, and incremental compilation disabled. It does not replace or claim a pass for the package-wide gate.

Acceptance covered: three classes of delimiter collisions; 512 structured identity round trips including separator/quote/backslash/Unicode values; actual React layer keys; 128 failed configurations followed by 128 healthy revisits; exact source/layer → static → neutral chain; duplicate suppression; final-fallback monotonicity; captured old source/layer/fallback callbacks; A → B → A isolation; latest same-identity parent callback; StrictMode and unmount; first-commit projection reset; pack/version/character-ID isolation; stable venue callback; and preserved reduced-motion behavior. Captured JSX callbacks are invoked through `act` with a settled microtask. The harness captures public JSX arguments and forwards the real JSX runtime, not React's private fiber/DOM state.

### Negative control and the outstanding web gate

After stopping the dashboard, both production components were temporarily replaced with their exact frozen Git contents **in this isolated worktree only**, while retaining the new regression harness. The web tests then produced **17 failures and 2 passes**, demonstrating detection of the original defects. Restoring the implementation was verified by SHA-256; the same 19 tests passed again (Vitest reported 2.16 seconds). See `E/negative-control.json`, `E/baseline-regression.log`, and `E/post-control-web-unit.log`.

The same controlled comparison was run for package-wide web typechecking. Both versions emitted exactly **1,480 identical diagnostic lines**, with no new or removed diagnostics. The fresh checkout lacks generated Prisma client types; many unrelated API/DB imports consequently fail. See `E/typecheck-baseline-comparison.json`, `E/baseline-web-typecheck.log`, and `E/final-web-typecheck.log`.

An attempted `corepack pnpm --dir packages/db exec prisma generate --no-engine` could not use an available matching engine. Its attempts to reach the engine host were blocked before connection. No database was started or contacted, no schema was changed, and no engine was downloaded. Root must rerun the package-wide web gate with approved local pinned dependencies/generated client types. This result does not claim that gate passed or that every unrelated diagnostic has been repaired.

Initial test-harness capture/type errors and the Windows NODE_OPTIONS quoting error were corrected; their earlier logs remain retained rather than deleted.

## Rendered proof and local observations

Command: `node E/run-browser.cjs 01`. It invokes the existing `playwright.visual.config.ts`, only `tests/visual/character-family-rigs.spec.ts`, one `desktop-1440x900` project, one worker, `--reporter=list`, and a new absolute `--output` ending in `E/playwright-run-01`. The spec explicitly sets each required viewport; this produced four tests, not twelve repeated project combinations. Exact argv is in `E/browser-01.json`.

**4/4 tests passed**, 47.8 seconds reported by Playwright, 49.38 seconds including launcher overhead. Each width exercised normal, explicit reduced motion, system reduced motion, static fallback, double failure, replacement after late errors, and normal recovery. All 28 state checkpoints had zero axe violations, zero page errors, and no detected horizontal overflow. All four added controls were reached and activated with Tab/Enter at every width. Three rigs were present throughout.

| CSS viewport | Normal navigation | Explicit reduced | System reduced | Static fallback | Double failure | Isolation-page navigation |
| ------------ | ----------------: | ---------------: | -------------: | --------------: | -------------: | ------------------------: |
| 320 × 740    |       1,322.58 ms |      1,287.49 ms |    1,421.35 ms |     1,784.53 ms |    1,693.37 ms |               1,297.06 ms |
| 820 × 1180   |       1,215.24 ms |      1,147.25 ms |    1,264.14 ms |     1,185.65 ms |    1,318.65 ms |               1,694.62 ms |
| 1024 × 900   |       1,203.73 ms |      1,630.83 ms |    1,263.50 ms |     1,291.99 ms |    1,725.09 ms |               1,757.47 ms |
| 1440 × 900   |       1,627.69 ms |      1,150.32 ms |    1,217.38 ms |     1,223.44 ms |    1,210.13 ms |               1,223.43 ms |

These are observed local development navigation-plus-hydration durations, not production performance, interaction latency, or recovery timing. The route was prewarmed; an earlier HTTP readiness request returned 200 in 8.84 seconds including initial compilation. Replacement and normal recovery happen on the same isolation-page navigation and reuse its recorded navigation duration.

Each width rendered seven healthy layer images normally, three exact static fallbacks after layer failure, and zero images after double failure. There were exactly three fallback HTTP requests during each double-failure journey, with no additional fallback request after late errors. Parent notifications were three at static fallback and six at final fallback; replacement and recovery had zero notifications after seven deliberately delivered retired-image errors.

Each width recorded 24 total locally fulfilled failing image HTTP requests across the complete journey: seven static-stage failures, ten double-stage failures, and seven delayed retired-configuration requests. There were no network-level request failures and no browser attempts to external origins. Normal sources are data URLs, so HTTP request counters exclude their loads; healthy image completion/natural size is checked separately. Native DOM error observation at double failure was 9 at 320 pixels and 10 at the other widths, because removed-image events need not reach the window capture listener. The explicit retired-event delivery counter records seven independently. These counts are observations, not invented equality between HTTP and DOM events.

Browser proof uses late **native image events** on retired nodes. The unit tests separately invoke captured **React callbacks** directly after settlement; the two proof layers are not conflated.

Screenshots were inspected at all four widths, including 320-pixel stacked controls/replacement, 820-pixel normal layout, 1024-pixel replacement/focus, and 1440-pixel neutral final fallback. No clipped copy, overlapping controls, or layout breakage was observed. No visual redesign was performed. The screenshot environment substitutes OS-local Arial through Next's built-in offline font-test hook; production Google font rendering is not proved, and no font file was copied, downloaded, or distributed.

Artifacts: `E/browser-summary.json`; four `observations.json` files and 28 PNG files under `E/playwright-run-01/<test-output>/`. Every screenshot was written via `testInfo.outputPath`. Screenshot names are `normal.png`, `explicit-reduced.png`, `system-reduced.png`, `static-fallback.png`, `double-failure.png`, `replacement-after-late-errors.png`, and `normal-recovery.png`.

## Server lifecycle and safety read-back

The one dashboard was launched by `node E/start-dashboard.cjs` at **2026-09-09T23:27:57.845Z**, after successfully binding and releasing `127.0.0.1:43271` as a free-port probe. Next ran `dev --hostname 127.0.0.1 --port 43271` from the isolated `apps/dashboard`, with output in `apps/dashboard/.next/character-runtime-20260909-2306`. The full resolved Node/Next argv and explicit sanitized environment are in `E/server-start.json`.

Launcher PID: **36380**. Next CLI PID: **31136**. Actual listening Next server PID: **31776**, verified to be a child of 31136. Its build child **27756** was included in the owned process-tree stop. URL: `http://127.0.0.1:43271/dev-fixtures/character-family-rigs`. The existing development fixture guard and no-key fixture layout were used; application authentication code was not stubbed or edited.

`taskkill /PID 31136 /T /F` stopped only the verified owned process tree. At **2026-09-09T23:31:15.4647801Z**, read-back confirmed the owned CLI/server PIDs were gone and no listener remained on port 43271. See `E/server-process-readback.json`, `E/server-stop.json`, `E/server.stdout.log`, and `E/server.stderr.log`. Webpack emitted three large-string cache warnings, not browser page errors.

The child environment was built from an OS-variable allowlist, with empty provider/auth/DB configuration and telemetry disabled. Relevant directories were checked for environment-file names without reading their contents; none were autoloaded. A disposable network guard allowed only the fixture's loopback port (plus local IPC), and Playwright separately blocked external browser origins. The audit recorded ten blocked Prisma engine connection attempts and one blocked Next registry version-check attempt. **No external fetch completed or supplied data to the proof.**

No live provider, database, Redis, storage service/emulator, worker, deployment, customer communication, account change, spend, billing activation, source asset change, or final art was used or performed. Existing local neutral SVG fixtures were the only character artwork. No environment or credential file or personal browser profile was read/copied. No source-checkout build/test process was started, and no other process's output was deleted.

## Remaining P07-05 limits and delivery

This closes the bounded four-defect resilience implementation with local component/browser evidence, not the whole P07-05 product requirement. It does not supply a candidate workbench, selection/ranking, approval, activation, publication, art refinement, character source/style system, final Tochi, production-provider proof, production fonts, production performance, or a customer live journey. Unsupported-context handling and static fallback internals outside the owned components were left unchanged.

Root retains integration and acceptance authority. The outstanding package-wide web typecheck must remain visible during review. No shared contract change was needed; no reserved neighboring workstream was taken over.

The binary-safe patch is `E/character-runtime.patch`, generated from the frozen baseline through the final containing commit using `git diff --binary 14be680d5171e2a84dfb2b892167c265f98aac0b..HEAD --output character-runtime.patch` with E as the working directory. `E/FINALIZATION.json` is the post-commit authority for final SHA/status and patch integrity. Retained evidence is local and ignored; it is not misrepresented as committed production data. The handoff archive is placed beside the isolated worktree, under the same `95 AI Staging/Torchiko Character Runtime 2026-09-09` directory.
