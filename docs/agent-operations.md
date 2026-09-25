# Torchiko agent operations

This is a route to owners, not a duplicate company database. Run `node scripts/agent-status.mjs` in the checkout being used. It needs no package install and makes no network or provider calls. Its local observations are current at execution time; hosted and mailbox state remain unverified until their owner surfaces are checked. Read the exact current handoff before acting.

## Purpose and current direction

Torchiko is preparing a high-quality, fast, uncluttered, conversational AI visitor guide for sales. Guests can supply context in conversation. `PathFinder` remains the technical repository and legacy data label. The founder's current priority and the live work queue are held in AwesomeVault's `02 Projects/PathFinder.md`, `02 Projects/PathFinder/Open Work/Torchiko Open Work.md`, and AI-OS run state. Check those and any newer explicit direction; this paragraph is durable direction, not a live release report.

## Sources and owner interfaces

| Need | Owner / how to inspect |
| --- | --- |
| Code and architecture | This Git repository. `README.md`, `docs/repository-onboarding.md`, `node scripts/torchiko.mjs repo map --json`, and the affected code. `docs/system-state/` is dated evidence; verify against code and the current checkout. |
| Local test and staging path | `docs/repository-onboarding.md`, generated `docs/repository-command-index.md`, `docs/staging-release-workflow.md`. `pnpm typecheck`, `pnpm lint`, `pnpm test:scripts`, and topic tests found with `node scripts/torchiko.mjs tests find <topic> --json`. `pnpm local-staging:up/status/stop` uses disposable, provider-dark services. |
| Hosted staging and releases | `docs/staging-release-workflow.md`, `docs/railway-staging.md`, and exact release receipts. `staging.torchiko.com` is the separate marketing Site; `app.staging.torchiko.com` is the dashboard. Check exact hosted revision and resource identities before claiming a deployed state. Staging acceptance never promotes production. |
| Product CRM and prospect operations | `packages/api/src/routers/admin/prospect-crm-*.ts`, `packages/db` domain actions, and the authenticated dashboard/agent bridge. `node scripts/torchiko.mjs tools list --json` shows source-declared agent tools; it does not prove a credential or live connection. Use the current CRM owner's supported client/hand-off, never direct DB writes or copies of the 16,000-plus-row workbook. |
| Outreach and research | CRM evidence and reviewed outreach owners; `docs/agent-operations.md` records only the boundary. Retrieve a chosen prospect and evidence, check relevance/freshness, research just in time if material, attach source provenance, prepare a concise candidate, submit for review, then read the immutable review state. No send follows from draft or staging approval. |
| Writing sources | Venue evidence establishes venue facts. Product source establishes product claims. Write Like Tom supplies style. Approved Language supplies separately accepted Torchiko phrasing. Sales guidance and the current task supply purpose. Keep source IDs/versions with the candidate; none of these sources substitutes for another. Find the current owner in the vault's `95 AI Staging/Write Like Tom/` and Torchiko Sales Writing Reference handoff before using dated reference material. |
| Company mailbox | Torchiko company mailbox through the CRM/correspondence owner and its authenticated connector. A mailbox address in a record or OAuth code in this repo is not connection proof. Inspect current auth, sync, exact thread/prospect match, and result readback. Personal Gmail is not a fallback sender. |
| Cross-agent context | AwesomeVault `08 System/AGENT_ENTRY.md`, `02 Projects/PathFinder/CANONICAL.md`, source-context skill, current AI-OS run and exact handoff. The vault stores durable context and compact pointers; CRM records, code, correspondence, and secrets remain with their owners. |
| Hermes, Codex, Muse | Agents use the same source-backed task and owner boundaries. When loaded, Hermes' existing `get_ai_os_context` and `get_ai_run_status` tools can read bounded vault context and an exact AI-OS run; verify the plugin/runtime before claiming access. `docs/agent-bridge-runner.md` describes Torchiko's scoped bridge; its adapter is not evidence of a running Torchiko bridge session. Codex uses this file and `AGENTS.md`; Muse consumes a bounded source-context packet when that route is fresh. |

## Action boundaries

The agent may inspect code, create isolated branches, make scoped reversible changes, run provider-dark tests, and leave handoffs. CRM write operations must pass the authenticated owner interface and its review states. Research and drafting use a single selected task, not a bulk enrichment prerequisite. Customer contact, real email sends, production promotion, live provider use, data imports, migrations, deletion, and purchases require their separate owner authority and readback. Preserve existing releases and rollback paths. Do not inspect or copy raw credentials.

## Handoff minimum

Record `task`, `owner`, `repository/worktree`, `base and result commit`, `changed paths`, `status`, `validation with exact command/result`, `unresolved issues`, `artifact links`, and `next safe action` in the existing task or AI-OS run. Use the current project's exact handoff writer and vault staging pointer where applicable. A result is complete only when the written artifact is read back and its relevant tests or workflow checks pass.
