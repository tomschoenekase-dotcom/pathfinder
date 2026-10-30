# Torchiko release verification

`pnpm verify:release` is the release-assessment entry point. It composes existing canonical gates,
stops on the first failure, distinguishes unavailable hosted evidence from a pass, and writes both a
machine-readable JSON report and a short founder-readable Markdown report under
`artifacts/release-verification/`.

## Profiles

- `static` (default): fast configuration, public-surface, AI budget/provider, tenancy, SQL, Docker,
  character, agent-tool and scenario checks.
- `candidate`: the static checks plus typecheck, lint, the full test suite, build, client-bundle
  secret scanning, browser-foundation contracts, accessibility contracts, and the deterministic
  phone/tablet/desktop Chromium smoke described in `docs/mobile-visual-browser-smoke.md`. A clean
  successful candidate is `ready-for-staging-review`, not production-approved.
- `staging`: static checks plus a bounded HTTPS read of the canonical staging health endpoint. It
  requires an exact 40-character revision equal to the checked-out `HEAD` and verifies the isolated
  staging database, Redis and storage resource fingerprints. Missing or mismatched hosted evidence
  is `blocked`/`not-ready`, never a false green.

```powershell
pnpm verify:release
pnpm verify:release --profile candidate
pnpm verify:release --profile staging --revision <exact-40-character-sha>
```

Use `--report artifacts/release-verification/custom-name.json` to select a repository-contained
report path. The sibling Markdown report is generated automatically. Reports contain gate names,
status and duration, but do not persist command output or environment values.

After a clean candidate report and matching `pnpm staging:handoff`, use
`pnpm release:evidence:prepare --assessment <report.json> --handoff <handoff.json>` to produce a
deterministic, schema-compatible record payload. The command is offline and does not record,
deploy, or authorize anything. See `docs/platform-release-evidence.md`.

## Scope and release authority

A green local assessment proves only the checked-in/local gates. Exact staging health proves the
deployed revision and core resource identity, not provider quality, OAuth, mail delivery,
authenticated or deployed browser journeys, billing sandbox behavior or customer acceptance. Record
those as separate release evidence when applicable.

No profile deploys, migrates, sends, enables live billing, changes customer state or authorizes
production. Consequential production rollout remains founder-aware/approved. Application rollback is
an immutable prior-revision redeploy; database recovery follows the forward-repair incident runbook,
never an improvised destructive rollback.

## Rolling back a newly introduced AI model key

Before redeploying a revision that predates a model key (for example,
`guest-chat-luna-reasoning`), restore configuration compatibility while the newer
revision is still running:

1. Record the current scoped configuration and intended compatible replacement
   in the release evidence. Use the governed admin configuration workflow to
   replace references to the new key, including primary and fallback selections,
   or reset the affected override to its inherited configuration. Preserve the
   audit history; do not delete database rows.
2. Check disabled overrides too. Disabling an override alone is insufficient:
   persisted values are schema-validated before their enabled state is applied.
   A reset tombstone is skipped before this validation. Confirm all applicable
   workload, client and venue scopes resolve with keys supported by the target.
3. Replace any `GUEST_CHAT_DEFAULT_MODEL_KEY` environment selection unsupported
   by the target with a supported, qualified model key on every affected service.
   Recheck the effective guest route and its limits before the old revision starts.
4. Redeploy the immutable prior revision, then verify service health and a guest
   answer. Record both configuration restoration and application rollback timing.

Do not enable a new model key in production until this ordering has been rehearsed
in staging. A code-only release with the new key unused does not establish model
quality or prove rollback of a later configuration change.
