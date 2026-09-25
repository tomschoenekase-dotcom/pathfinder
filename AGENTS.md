# Torchiko agent entry

Torchiko is the company and product; PathFinder is this monorepo's historical technical name. This file routes a worker to current owners. It is not a release or contact authorization.

1. Read [agent operations](docs/agent-operations.md), then run `node scripts/agent-status.mjs` and `git status --short --branch` in this checkout. The status command needs no installed packages, is read only, and separates source availability from live connectivity.
2. Check the exact task, current owner worktree, and current handoff before editing. In Tom's vault, start at `02 Projects/PathFinder.md`, `02 Projects/PathFinder/CANONICAL.md`, and the current AI-OS Torchiko run. An older packet or a `RUNNING` row alone does not establish current authority or process liveness.
3. For code, use [repository onboarding](docs/repository-onboarding.md), the generated [command index](docs/repository-command-index.md), and `node scripts/torchiko.mjs tests find <topic> --json`. Read the affected source and focused tests. Preserve unrelated dirty work.
4. The product API/DB owners, not an agent's files, own CRM, prospects, evidence, drafts, review and correspondence. Use the authenticated, scoped owner interface in [agent operations](docs/agent-operations.md); inspect availability before claiming it works. Keep venue evidence, product truth, Write Like Tom, and Approved Language distinct.
5. Local development, Railway staging, and production are separate. Staging is for validation. Production changes, customer data writes, provider calls, mailbox sends, and release promotion require their existing exact owner gates. Never use personal Gmail as Torchiko's company sender.
6. Leave a small source-bound handoff through the current task/AI-OS owner: task, owner, checkout and commit, changed paths, tests, blockers, artifacts, and next safe action. Link it from the appropriate vault staging pointer; do not create another CRM or task database.

`CLAUDE.md` contains deeper engineering constraints. Its scope applies regardless of which agent edits this repository. Host-specific adapters may add transport details but must use these same owners and boundaries.
