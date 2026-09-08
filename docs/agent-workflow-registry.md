# Registered skills and workflows

The registry stores immutable, venue-scoped portable text and its manifest. A registration is an artifact for inspection. It does not activate behavior, change permissions, or prove that its declared source author reviewed it.

## Agent integration

- `torchiko.agent_workflows.register_version` requires `agent-improvements:propose`, the exact tenant/venue, an enabled agent identity, an assigned live run, and an online worker owning a current credential with that capability. The run must be a canonical operator task, specialist delegation, or dedicated registration task. Revoked credentials, expired leases, and mismatched workers are rejected even on retries.
- Supply an operation UUID, portable text (at most 50,000 characters), a strict manifest, and declared provenance. The server computes the body and manifest hashes. An unchanged same-actor retry returns the original record; changing content under the same operation conflicts.
- `torchiko.agent_workflows.get_compatible_versions` requires `resources:read` and exact venue scope. It accepts up to five registry keys and returns each latest registered version with current compatibility. It does not load the entire catalog. Required tools are compared with the intersection of registered server tools and the caller's credential capabilities.
- `NOT_FOUND`, `INVALID_ARTIFACT`, and `MISSING_TOOLS` are explicit read outcomes. A successful historical registration retry may now have missing tools. Neither a registration nor a compatible read authorizes execution.

The administrator routes `registerAgentWorkflowVersion` and `listCompatibleAgentWorkflowVersions` use the same database helpers. Administrator inspection supports up to 50 explicit keys. Registration itself does not select a workflow for a run.

## Version and evidence rules

Each key starts at version 1. A later version must name the exact preceding scoped version and its rollback content hash. Versions cannot be edited or deleted. Reads verify the stored text and manifest hashes and check that duplicated version, kind, key, and required-tool fields agree with the manifest.

Provenance is returned as `DECLARED_NOT_VERIFIED`: source references and labels such as `HUMAN_AUTHORED` are caller declarations, not verified authorship. The registry has no shared cross-tenant publishing path.

New skill/workflow evaluation evidence must reference `AgentWorkflowVersion:<uuid>`, its exact version and content hash, and currently available tools. Existing historical evidence stays readable. Promotion, canary assignment, revocation, and run-bound selective execution require their own reviewed lifecycle; this registry grants none of them.

## Accepted corrections as improvement evidence

The administrator `recordAgentRunOutcome` action accepts an optional `sourceQuestion` containing
`questionId` and `expectedUpdatedAt`. It verifies an answered question belonging to the same
tenant, venue, terminal run, and agent identity. A source snapshot retains the question ID,
question version, answered timestamp, and SHA-256 of the exact UTF-8 answer. It does not copy
the question, private answer, or answerer into the outcome. The existing human review supplies
the quality verdict and summary; an answer alone is not interpreted as a correction or permission.

An exact operation replay returns the original observation. Changing its source ID or version
conflicts. The snapshot is historical evidence, not a claim that the answer remains the current
source. The scoped `outcomes` MCP resource returns these source descriptors for candidate authors.

When `prepareAgentImprovementProposal` or `torchiko.agent_improvements.propose` uses question-sourced
evidence, the candidate must include a source-linked mixed or negative observation and a
`generalization` object: an explicit `rationale`, `counterexampleObservationIds`, and `exclusions`.
Counterexamples must be distinct from the source-linked corrections and selected from the same
scoped evidence set. Existing tenant, venue, identity, and task-class checks still apply.
The immutable candidate snapshot retains this rationale, counterexamples, exclusions, and safe
source descriptors. Reordering counterexample IDs does not create a different operation.

These checks establish provenance and require the author to state where a proposed rule applies
and fails. They do not prove its semantic correctness, redact arbitrary text supplied by an
author, or establish a universally valid rule from one customer's answer. The candidate remains
pending human review and separate baseline/holdout validation; this path cannot activate a
workflow, widen authority, publish a shared skill, or approve itself.

## Reviewed activation and delegation

The activation lifecycle uses a separate exact approval request, human decision, and canonical apply operation. A registered version must satisfy its promotion assessment and canary policy before activation. Run bindings retain the selected version and selection evidence; rollback and revocation do not rewrite that history. The administrator review panel exposes these approval and apply steps.

`pathfinder.delegate_specialist` accepts an optional `executionLeaseToken`. It is required when the parent has a selected workflow (including a canary selection of the prior version). The same transaction that creates the child checks the exact live parent lease, current authority, and the policy's `AGENT_DELEGATION` action class. Operator-question and billing-proposal effects remain unsupported for workflow activation.

Delegation retries serialize on the tenant and operation UUID. An exact historical retry returns the original child before checking the current lease; it cannot create another child after expiry or revocation. A changed parent, specialist, venue, or instructions conflicts. A new operation must pass current authority checks. Delegating to the parent's own identity is rejected.

The transaction captures at most 50 active child workflow keys and locks their sorted union with the parent's immutable binding keys before locking the parent run. It binds the child against that captured key set. A newly activated registry key outside the captured set applies to subsequent runs. This bounded snapshot prevents a later key discovery from reversing the head-before-run lock order.

## Retained local proof

Migration 220 supplies scoped keys, predecessor foreign keys, and immutable database triggers. Disposable PostgreSQL checks exercise version creation, exact replay/conflict, rollback predecessor, machine identity/worker/credential/lease boundaries, and append-only history. MCP tests cover read-only scope denial, the five-key bound, current credential/tool intersection, and explicit non-activation results. These tests use fixture providers and are not live model quality evidence.

The workflow delegation extension has a retained [UTC PostgreSQL proof](evidence/workflow-delegation-native-postgres-2026-09-07.json): concurrent operation replay, exact parent lease admission, expired/revoked denial, captured child bindings, and cancellation of both running and queued selected runs. The fixture exposed and fixed missing terminal timestamps in canonical revocation. It passed after 224 fresh migrations; the unrelated intake224 tables were present but this journey does not verify V1 onboarding.
