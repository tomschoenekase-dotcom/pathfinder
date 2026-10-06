# CI optimization (packet W13)

Historical packet W13: implemented on a worktree branch at the time of writing. Every speedup below is an
estimate from the measured baseline. Measuring the real effect is a follow-up run (see "Follow-up
measurement").

Prerequisite: the operator production release at `9f726afd101cc3a3cb3c96d9504e06adc9618642` is
recorded complete in `docs/implementation/torchiko-operator-checkpoints.md` (2026-10-01 entries).

## 1. Master failure diagnosis (run 36960887733, job 110694090121)

The failing step was "Verify workspace test graph" (step 55). One test failed out of the whole
graph; every other workspace passed (dashboard: 1 failed, 266 passed, 1 skipped).

- Test: `apps/dashboard/components/admin/VenuePackageLifecycleControls.test.tsx`
  "retains the command key for an unchanged ambiguous retry".
- Assertion: `expected "spy" to be called 2 times, but got 1 times`.
- Classification: a racy test, not a source regression. Evidence:
  - The same test file passes 16/16 in three isolated local runs and passed in the identical
    workspace graph on later CI runs of the same product code (run 36956001668, run 36964255736
    dashboard: 267 files passed).
  - The component guards re-entry with `actionInFlight.current`, cleared in a `finally` block
    after the rejected mutation settles. The test clicked the same button again as soon as the
    first `approve` mock call was observed (`waitFor(calledTimes(1))`), before the rejection
    handler had run on a loaded CI worker. The second click was then correctly fenced as a
    same-tick duplicate, so the spy saw one call.
- Fix (test only, no retry, no skip): the test now waits for the button to be enabled again
  (the observable end of the in-flight window) before the retry click. The component and its
  command-key behavior are unchanged. File:
  `apps/dashboard/components/admin/VenuePackageLifecycleControls.test.tsx`.

Related finding, not fixed here (docs content on another branch): runs 36963171218 and
36964255736 on `machine/torchiko/20260930-operator-program` failed in `pnpm test:scripts`, not in
the workspace graph. Two script tests failed
(`scripts/migration-documentation-safety.test.mjs`, "every retained historical database
instruction is prominently deactivated" and "September 30 approval is exact-scope, guarded, ...").
The offending file is `docs/implementation/torchiko-operator-checkpoints.md`, which gained a
database-command mention without the required deactivation marker. This proves docs-only commits
can fail CI, so the optimized plan keeps `pnpm test:scripts` mandatory for docs-only changes.
The owner or lead should fix that docs entry on the operator branch.

## 2. Baseline (measured from the GitHub Actions API)

Wall time is `updated_at - created_at` of the run (for re-run attempts, from `run_started_at`).
Last 17 completed runs of `ci.yml`:

| Run         | Event            | Branch                         | Content      | Result                 | Wall (min) |
| ----------- | ---------------- | ------------------------------ | ------------ | ---------------------- | ---------- |
| 36964255736 | push             | operator-program               | docs         | failure (script tests) | 53.2       |
| 36963171218 | push             | operator-program               | docs         | failure (script tests) | 53.3       |
| 36960887733 | push             | master                         | merge        | failure (flaky test)   | 52.6       |
| 36956001668 | pull_request     | codex/pathfinder-v2-staging    | promotion PR | success                | 55.4       |
| 36946813400 | push (attempt 2) | codex/pathfinder-v2-staging    | merge        | success                | 52.5       |
| 36939930874 | push             | operator-program               | docs         | success                | 50.5       |
| 36910581005 | push (attempt 2) | operator-program               | docs         | success                | 45.2       |
| 36877213043 | push (attempt 2) | operator-program               | code + docs  | success                | 53.3       |
| 36875552060 | push             | operator-program               | code         | success                | 55.3       |
| 36773258490 | push             | release-b-operator             | code         | success                | 53.3       |
| 36765909509 | push             | release-b-operator             | merge        | failure                | 48.9       |
| 36759558858 | pull_request     | codex/pathfinder-v2-staging    | promotion PR | success                | 53.1       |
| 36744169026 | push             | codex/pathfinder-v2-staging    | merge        | success                | 54.1       |
| 36728374894 | push             | release-b-operator             | code         | success                | 35.2       |
| 36727216479 | push             | release-b-operator             | code         | failure                | 39.2       |
| 36726646618 | push             | release-b-operator             | code         | failure                | 14.8       |
| 36690083276 | push             | claude/torchiko-operator-oauth | code         | success                | 52.8       |

Median 52.8 min, range 14.8 to 55.4. Three runs were cancelled by hand while superseded (not in
the table). Docs-only commits cost the same as code commits (50.5 and 53.2 min).

Per-step baseline for the `ci` job (docs-only run 36939930874 / promotion PR 36956001668):

| Step                                                   | Docs-only run | Promotion PR  |
| ------------------------------------------------------ | ------------- | ------------- |
| Phone/tablet/desktop visual smoke (step 48)            | 24.4 min      | 25.7 min      |
| Browser-bundle secret build (step 49)                  | 6.5 min       | 7.2 min       |
| `turbo run typecheck` (step 52)                        | 6.7 min       | 8.1 min       |
| "Verify workspace test graph" (step 55)                | 7.0 min       | 7.7 min       |
| Disposable DB/Redis/S3 integration block (steps 21-45) | 2.1 min       | 2.3 min       |
| Static policy checks (steps 7-19)                      | 0.7 min       | about 0.5 min |
| `turbo run lint`                                       | 0.7 min       | 0.8 min       |
| `pnpm test:scripts`                                    | 0.4 min       | 0.4 min       |
| Install, containers, checkout, Playwright install      | about 1.5 min | about 1.5 min |

Parallel jobs: `visitor-launch` 13.9 min (browser install 1.5 min, browser tests 11.5 min),
`railway-iac` under 1 min. The critical path is the single serial `ci` job.

Cache status today: `actions/setup-node` with `cache: pnpm` is on in all three jobs (its key
includes OS, architecture and lockfile hash; installs take about 15 s). Playwright browsers and
turbo outputs are not cached.

## 3. Design

Files:

- `scripts/lib/ci-change-plan.mjs`: pure classifier (graph, categories, plan, outputs, explanation).
- `scripts/ci-change-plan.mjs`: CLI. Gathers `git diff --name-status -M -z` against the merge base,
  cross-checks the record count with `--shortstat`, builds the plan, writes step outputs, a JSON
  plan file and a Markdown explanation (also the job summary).
- `scripts/lib/ci-required-gate.mjs` and `scripts/ci-required-gate.mjs`: the aggregate gate.
- `scripts/lib/ci-turbo-filters.mjs`: validates the `--filter=<workspace>` list; used by
  `scripts/run-ci-workspace-tests.mjs` through `PATHFINDER_CI_TURBO_FILTERS`.
- `.github/workflows/ci.yml`: new `plan` and `ci-required` jobs, step conditions, triggers,
  concurrency.

### Input and base

- Pull request: diff of the checked-out merge commit against `pull_request.base.sha` (the merge
  base is verified with `git merge-base`).
- Push to a development branch: the whole branch against `origin/master` (merge base), not just the
  last push, so earlier unverified commits cannot hide behind a docs-only tip. Consequence: docs
  commits stacked on a branch that still differs from master in code remain a full run.
- The plan job checks out with `fetch-depth: 0`.

### Categories

| Category                          | Paths                                                                                                                                                                                                                                                                                      | Plan                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Policy, toolchain, infrastructure | root files, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, tsconfig, Dockerfiles, `railway*.json`, `.github/`, `.husky/`, `.railway/`, `scripts/`, `tools/`, `assets/`, `CLAUDE.md`, any workspace `package.json`, `packages/db/prisma/` (schema and migrations), `packages/auth/` | FULL                                |
| Shared tooling                    | `packages/config/`                                                                                                                                                                                                                                                                         | scoped to every workspace           |
| Workspace code                    | other files under `apps/*`, `packages/*`                                                                                                                                                                                                                                                   | owner plus all transitive consumers |
| Documentation                     | `docs/`, `qa/`, `memory/` (md, mdx, txt, images, json) and root `*.md` except `CLAUDE.md`                                                                                                                                                                                                  | docs-only unless consumed           |
| Anything else                     | unknown paths or file types                                                                                                                                                                                                                                                                | FULL                                |

Dependency graph: workspace `package.json` dependency fields (dependencies, dev, peer, optional)
UNION static import specifiers (bare workspace names and relative paths leaving a workspace).
The union catches undeclared couplings. Consumers are the reverse transitive closure.

Documentation consumption: for changed docs, all non-doc text files are scanned for the doc path,
its basename (not for generic README/index names), a nested docs directory prefix, or a bare
`'docs'` path segment (directory-level reads). Evidence in a workspace puts that workspace and its
consumers in scope. Evidence under `scripts/` is covered because script tests always run.
Evidence anywhere else (root, infrastructure, tooling) is FULL. Example: `docs/operator/manual.md`
is pinned by a `packages/api` test, so editing it is scoped to `packages/api` and its consumers.

Rename, copy, delete: a rename within one workspace or category is scoped. A rename across
workspaces or between docs and code, any copy, and any type change is FULL. A delete is classified
by the deleted path (a deleted workspace file scopes to its owner and consumers, a deleted policy
file is FULL); a deleted doc is checked against consumers still referencing it.

### Fail-safe conditions (all produce FULL)

Shallow history, missing or unfetched base, zero SHA, no merge base, truncated or malformed diff
output, unknown diff status, unsafe paths, record-count mismatch with `--shortstat`, empty change
list, more than 1500 changed files, unknown workspace patterns, any thrown error (the CLI also
catches argument and filesystem errors and still emits FULL), unsafe workspace names in the filter
list, and events other than `pull_request` and `push`.

### Plan outputs and jobs

`mode` is `full`, `scoped` or `docs-only`. Boolean outputs: `run_database_integration`,
`run_browser_gates`, `run_visitor_launch`, `run_workspace_graph`, plus `turbo_filters`.

- Always required: `ci` (static policy checks, staging admission contract tests, `pnpm test:scripts`),
  `railway-iac`, `ci-required`.
- `run_database_integration` skips the disposable DB/Redis/S3 integration block and the billing
  disposable proof unless the affected set contains db, api, jobs, billing, ai, analytics, auth,
  contracts, config, intake-engine or workers.
- `run_browser_gates` and `run_visitor_launch` skip Chromium install, visual smoke, the browser
  bundle secret scan, Packet 2 DOM and accessibility gates, and the `visitor-launch` job unless
  `apps/dashboard` or `apps/web` is affected.
- `run_workspace_graph` runs `turbo typecheck`, `lint` and workspace tests, scoped with
  `--filter=<workspace>` for each affected workspace (no filter in FULL). A docs-only plan skips
  them.

The explanation lists required and not-required jobs and is written to the job summary.

### Workflow wiring (conservative)

- A step or job is skipped only when its plan output is exactly `'false'`. A failed or missing
  plan yields empty outputs, which run everything.
- `ci` and `visitor-launch` use `!cancelled()` so they are never skipped by a failed `plan`.
- `railway-iac` is unchanged and independent.
- `ci-required` runs `always()` after `plan`, `ci`, `railway-iac`, `visitor-launch` and passes only
  when each succeeded, or `visitor-launch` was skipped with `run_visitor_launch=false` in a
  non-full plan. A failed `plan` job also fails the gate. Existing check names (`ci`,
  `visitor-launch`, `railway-iac`) keep their semantics; no branch protection change is required.
- YAML-level override (independent of the classifier): the `plan` job runs a "Force the full
  suite" step instead of the classifier for merge queues, manual dispatch, any event other than
  `push` and `pull_request`, pushes to `master` and `codex/pathfinder-v2-staging`, pull requests
  from `codex/pathfinder-v2-staging`, and pull requests whose base is not `master`. The classifier
  also refuses those inputs itself.
- `merge_group` and `workflow_dispatch` triggers are added so those events run the full suite.
- Concurrency: superseded runs on development branches are cancelled. Never cancelled: master,
  the staging release branch, the promotion PR, `merge_group`, `workflow_dispatch`.

## 4. Safety invariants

1. Every release source tree requires full qualification. Staging pushes, production promotion
   PRs and master pushes run the full suite unless a recent complete full run proves the exact
   identical Git tree, including this workflow, dependencies, tests and policy. Manual runs and
   merge queues always run every gate independently. See the October 5 latency update below.
2. Selective success never counts as release approval. Identical-tree qualification is explicitly
   attributed to the original full run; it is not reported as execution on the new commit. Exact
   staging admission, production promotion and live deployment health remain independent.
3. Uncertainty means FULL. The only skip is a positive proof, and each skippable output must equal
   the literal string `false`.
4. Required checks always resolve. No required workflow is path-filtered; skipped jobs are covered
   by `ci-required`.
5. Docs-only changes still run the static policy checks, secret and surface boundary checks,
   dependency advisory audit, and the whole repository script suite (which pins docs content).
6. The classifier runs from the checked-out revision, the same trust level as the workflow file; a
   pull request that edits either is already reviewed code. The YAML override for release-bearing
   events does not depend on the classifier.
7. Turbo filters pass through a strict allow-list and are never interpolated into a shell command
   by expression; they travel in environment variables.
8. No cache was added. See below.

## 5. Caching review

- pnpm store: already cached by `setup-node`. Its key covers OS, architecture, Node setup and the
  lockfile hash. Left as is.
- Playwright browsers: not cached. A cache keyed on OS, architecture, the Playwright version from
  the lockfile and the browser list would only save the browser download (tens of seconds); the
  `--with-deps` apt installation still runs and dominates. It would need a newly pinned
  third-party action. Not worth the risk or the new pin for the estimated gain; deferred.
- Turbo: local cache is not persisted between runs and no remote cache is configured. Adding a
  persisted or remote turbo cache would let outputs produced by untrusted pull request code feed
  later jobs. Do not add one without separate scoping (for example read-only for release
  branches, write only from trusted refs) and a security review. Not added.
- The visual smoke step (about 25 min) is the dominant cost for any browser-affecting change.
  Sharding it across a job matrix is the largest remaining lever; it is not part of this change
  because it changes the check topology and needs an owner decision.

## 6. Expected effect (estimates, not measured)

Based on the baseline step times above:

- Docs-only (not consumed by workspace code): the `ci` job keeps install, containers, static
  checks and `test:scripts`, roughly 3 to 6 minutes, and `visitor-launch` is skipped. Estimated
  wall about 5 to 8 minutes against 50 to 53 today. The new serial `plan` job adds roughly
  0.5 to 1 minute (full-history checkout).
- Single non-browser workspace (for example `apps/workers`): skips visual smoke, bundle build,
  Playwright install, `visitor-launch`; typecheck, lint and tests scoped. Estimated 12 to 20 minutes.
- Browser-affecting change (`apps/web`, `apps/dashboard`, `packages/ui`, or anything they consume
  such as `packages/api`): the visual smoke step still dominates; estimated saving only the DB
  block and parts of the graph (about 2 to 10 minutes).
- Shared or policy changes, master, staging, promotion PR, merge queue: unchanged, about 50 minutes.
- Cancelling superseded development-branch runs removes wasted runner time on rapid pushes.

Master pushes stay at full length by design, so a docs-only merge to master still takes about
50 minutes. See owner decisions.

## 7. Rollback

Revert the workflow commit (this change as one commit restores `.github/workflows/ci.yml`,
`scripts/run-ci-workspace-tests.mjs`, and removes the new scripts and tests). With the original
`ci.yml`, no plan or gate job exists and every run is full. No branch protection change is
involved either way.

## 8. Follow-up measurement

After the branch is pushed and has run on GitHub:

1. A docs-only pull request, a single-workspace pull request, a shared-package pull request and a
   lockfile pull request; compare wall time and the plan summary against the baseline table.
2. Confirm `ci-required` is green on each and red when a required job is failed on purpose in a
   scratch branch.
3. Confirm a push to `codex/pathfinder-v2-staging` and a promotion PR show `mode=full` and run
   every step, and that staging admission still triggers.
4. Record the numbers in this file.

## 9. Owner actions and decisions

1. Review and merge. Do not push or trigger from the agent environment; the workflow has not run.
2. Optional branch protection hardening: add `ci-required` as a required check. Not needed for
   safety today (existing names `ci`, `visitor-launch`, `railway-iac` retain their semantics, and a
   job skipped by `if` counts as passing). Keep the existing required checks until `ci-required`
   has proven stable.
3. Decide whether to allow selective runs on `master` pushes. Not done: the packet keeps master
   full. A safe variant would require that the merged pull request ran a full suite on the same
   tree.
4. Decide whether to shard the visual smoke job (largest remaining cost).
5. Decide whether to add a Playwright browser cache and/or a scoped turbo cache (section 5).
6. Fix the docs entry in `docs/implementation/torchiko-operator-checkpoints.md` on the operator
   branch that fails `scripts/migration-documentation-safety.test.mjs` (see section 1).
7. The old stacked-docs behavior: docs commits on a long-lived branch that differs from master in
   code are full runs by design. A later enhancement could use the last fully green SHA as the
   base, but that needs a trustworthy record of that SHA.

## Parallel required checks — October 5 iteration update

The original CI critical path ran responsive browser smoke, secret scanning,
workspace builds/typechecks, and the workspace test graph one after another.
Required checks now use separate isolated runners:

- `policy-and-integration`: all original policy, advisory, disposable integration,
  client-bundle secret, DOM, accessibility, and script gates.
- `browser-gates`: the same responsive browser suite in three file/project shards.
  All phone, tablet and desktop cases remain; one worker per shard and existing
  retries/timeouts remain. Matrix fail-fast is disabled so evidence is retained.
- `workspace-checks`: the same typecheck, lint and complete planned workspace graph.

Each starts after `plan`, with the original synthetic environment and disposable
services. The existing protected `ci` check aggregates all three core jobs;
`ci-required` also requires them plus IaC and visitor-launch. Failed, cancelled,
missing, or unplanned skipped results still fail closed. This original parallelism update still
forced FULL on release events and did not change branch protection. The later identical-tree
update below changes source qualification deliberately.
Actual speed must be measured from the first hosted run; do not promise an ETA.
Playwright's supported sharding preserves files within each project:
https://playwright.dev/docs/test-sharding

### Code-only production iteration

For an edit with identical Prisma schema and migration files to the deployed
qualified release, compare the complete change set and manifest against that
release, and confirm the hosted active ledger already matches it. Use the code
release checks, exact-revision staging admission, production promotion gate and
same-SHA live health verification. Do not invoke the previous lineage migration
operator, stop all apps, park old queue records, or repeat the database restore
rehearsal when no database transition is being made. Existing backup evidence
remains retained. A schema/migration/ledger mismatch requires a separately
qualified database release; it cannot be classified as a code-only edit.
This procedure does not make unchecked code approved or alter provider switches.

Git-based production releases use Railway commit metadata. After a controlled
rollout sets `PATHFINDER_RELEASE_SHA`, clear that fallback with skip-deploys
once Git identity is proven. Leaving an old fixed value makes the existing
conflict check correctly reject the next commit as an unknown revision. Never
remove the conflict check or permit an unreviewed local-upload identity.

## October 5 measured latency repair

This revision is a CI-only change. Application code, migrations, provider switches,
Railway WaitForCI, hosted admission and production promotion remain unchanged.
The earlier W13 estimates and owner action list are historical. Native production
already uses Git deployment identity and WaitForCI; do not repeat migration/drain
work for a code-only release or rotate a token because a local helper failed.

### Evidence from actual hosted runs

| Run                                                                                         | Actual longest runner task                  | Meaning                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| [37354756228](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/37354756228) | Workspace 14.9 min: types 6.6, tests 6.3    | Sequential work; rerun metadata retains earlier successful jobs               |
| [37365255047](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/37365255047) | Workspace 18.9 min: types 8.2, tests 8.3    | Runner work is much shorter than the queue/outage and retry elapsed time      |
| [37361809310](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/37361809310) | Hosted staging admission 1.7 min            | Live resource/revision admission is not the long test bottleneck              |
| [37386735043](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/37386735043) | Visitor 13.9 min; workspace 12.6 min failed | Three dependent mock helpers were omitted from the initial affected preflight |

The guest-query CI failed at 23:21 UTC, but the continuation did not inspect it
until about 23:40. That agent response delay also contributed. Faster tests alone
cannot fix late diagnosis, repeated helper fixes or the GitHub runner incident.

### Changes

Workspace tests and types/lint run on separate runners. Both lanes remain required;
fail-fast is disabled and no assertion, suite, timeout or opt-in is removed. This
removes the 6-8 minute typecheck prerequisite before tests start. Browser and policy
jobs still limit the overall full run; this is not a promise of instant full CI.

The first hosted split exposed an implicit cache dependency: the test lane's
`^build` API TypeScript task exhausted the default 4GB heap even though the same
typecheck/build graph passed with 6GB in the parallel lane. The CI test wrapper
now uses `--only --cache=local:,remote:`: every selected test executes fresh,
without rebuilding dependencies. All tested workspaces also have typechecks;
the required type lane retains the identical `^build` graph and plan filters.
The reviewed tests consume workspace source rather than emitted build artifacts;
Prisma generation and character sync stay in both lanes. Because `--only` also
removes dependency cache hashes, test cache reads and writes are disabled.
Ordinary local `pnpm test` and `turbo.json` remain unchanged. Both lanes use the
qualified 6GB heap budget. The original failed run remains failed evidence.

A completed FULL run records a small artifact bound to repository, exact commit,
Git tree, run and attempt. A later push or PR may reuse it only when the official
GitHub commit tree exactly matches the current checkout and every expected full
job succeeded. Source changes in any file, including this workflow, dependencies,
tests or policy, invalidate reuse. The full source run must be no older than six
hours. Scoped and reused runs cannot seed or renew full evidence; fork sources,
missing jobs, wrong attempts, failed or skipped checks and stale artifacts refuse.
Only the exact bounded JSON ZIP entry is read, never unpacked or executed.

The plan reports `mode=verified-tree`, the original full run ID, timestamp and tree.
The aggregate independently compares that proof to its actual Git checkout. Current
policy/script/advisory checks and IaC still execute; fresh staging deployment
admission, protected production promotion and exact production health still apply.
Manual runs and merge queues always execute the full suite. Lookup errors or a
45-second lookup budget cause normal CI, never permission to release unchecked code.
Artifact names include the attempt, so normal reruns cannot collide with prior uploads.

First delivery of this workflow needs full qualification. Before claiming the
reuse speedup works, record one actual hosted full artifact and an actual identical
source-tree run using it. Local fixtures are not hosted acceptance. GitHub queues,
build duration, changed merge trees and live health failures can still add time.

### Procedure for the next "update production"

1. Collect the completed Claude branches and existing guest fix into one coherent
   candidate; use the real frozen staging base. Preserve other work and exact source
   evidence. Do not push a sequence of partially diagnosed helper fixes.
2. Before pushing, run the complete affected package/dependent test graph, not just
   the new test file. For retrieval this includes voice and evaluation mock helpers;
   for MCP use the disposable five-operation flow. Resolve any failure fully once.
   Use the existing dependency-aware change plan and validated Turbo filters.
3. Inspect one bounded exact candidate CI status, then act on the first new failure.
   Distinguish queued runner time from running test time. Do not restart an unchanged
   failing run. Keep deterministic mocks and assertions intact.
4. Use supported release assessment/handoff and genuine local-owner prepublication
   finalization against the frozen base. Attribute reused proof to its actual source
   revision; do not label it local execution on the new SHA or hardcode ten jobs.
   The full workflow now has eleven jobs, including both workspace matrix lanes.
5. Deploy staging with the actual owner identity, pass hosted live admission, then
   pass the real production promotion gate. If merges keep the identical qualified
   source tree, metadata reuse avoids new full test cycles; changed trees require
   fresh qualification. Native production WaitForCI and exact three-service health
   remain required. Code-only changes do not repeat backup/restore/migration/drain.
6. Check the changed guest/MCP flow once in production and return its exact revision.
   Refresh an unchanged plugin catalog only when a catalog change requires it.

This workflow changes the source qualification rule openly; it does not mark a
failed check green, disable production protection or announce deployment from CI.
