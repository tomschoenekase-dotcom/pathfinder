# Agent learning and organizational knowledge boundary

Torchiko must retain evidence that can improve work without becoming a second Hermes memory system or treating Obsidian as an operational database.

## Ownership

| State                    | Authority                                 | Examples                                                                       |
| ------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Private role memory      | Hermes profile                            | specialist methods, personal failure patterns, Tom's role-specific preferences |
| Shared durable knowledge | Obsidian / Tom OS                         | strategy, decisions, sourced research, SOPs, cross-team lessons                |
| Live business facts      | Torchiko database                         | clients, venues, support, onboarding, approvals, current usage, active runs    |
| Active work              | Torchiko AgentRun or proven Hermes Kanban | assignments, dependencies, blockers, handoffs, retries, completion             |

## Promotion contract

Agents must route a finding to one primary destination:

1. keep role-specific learning private in Hermes;
2. propose cross-role learning to the Obsidian AI Knowledge Inbox;
3. write live facts through a scoped Torchiko domain action;
4. create durable work when action is needed; or
5. keep task-local scratch work ephemeral.

The current authorized Obsidian implementation is intentionally human-review-first:

- protocol: `C:\Users\tomsc\Downloads\AwesomeVault\08 System\Torchiko AI Knowledge Promotion Protocol.md`;
- template: `C:\Users\tomsc\Downloads\AwesomeVault\90 Templates\AI Knowledge Candidate.md`;
- inbox: `C:\Users\tomsc\Downloads\AwesomeVault\95 AI Staging\Torchiko AI Knowledge Inbox.md`.

No Torchiko API or MCP tool currently writes these files. That is deliberate. A future machine interface must prove path allowlisting, strict schema validation, provenance, deduplication, contradiction handling, idempotency, audit evidence, and safe review behavior before it can be enabled.

## Learning order

Do not add reputation scores before outcome evidence. The safe sequence is:

1. retain append-only human review and business outcome evidence;
2. link it to logical agent identity, model, task class, and workflow/skill version;
3. build transparent read-only rollups;
4. validate that the rollups predict actual quality;
5. use the validated signal for routing or autonomy decisions.

Completion alone is not a quality outcome. A failed recommendation can be technically completed, and a blocked run can be the safest correct result.
