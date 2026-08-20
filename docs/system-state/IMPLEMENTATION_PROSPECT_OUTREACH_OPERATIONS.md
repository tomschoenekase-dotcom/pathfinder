# Implementation state: prospect outreach operations

Implemented on `codex/torchiko-crm-foundation-20260819` in the isolated CRM worktree.

> Historical implementation note superseded by `ADR-CRM-CANONICALIZATION-2026-08-20`.

This layer originally used Resend for prospect correspondence. That prospect runtime is retired. Gmail is the approved provider behind a provider-neutral adapter, but production OAuth/client, Pub/Sub persistence, watch renewal, reconciliation scheduling, and provider-health composition remain incomplete.

Provider delivery remains dark by default. No credentials were read, no provider account was changed, no message was sent, and no real workbook was imported.

Primary design and runbook: `docs/sales/PROSPECT_OUTREACH_OPERATIONS.md`.
