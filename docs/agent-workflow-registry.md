# Registered skills and workflows

The registry stores immutable, venue-scoped portable text and its manifest. A registration is an artifact for inspection. It does not activate behavior, change permissions, or prove that its declared source author reviewed it.

## Agent integration

- `torchiko.agent_workflows.register_version` requires `agent-improvements:propose`, the exact tenant/venue, an enabled agent identity, an assigned live run, and an online worker owning a current credential with that capability. The run must be a canonical operator task, specialist delegation, or dedicated registration task. Revoked credentials, expired leases, and mismatched workers are rejected even on retries.
- Supply an operation UUID, portable text (at most 50,000 characters), a strict manifest, and declared provenance. The server computes the body and manifest hashes. An unchanged same-actor retry returns the original record; changing content under the same operation conflicts.
- `torchiko.agent_workflows.get_compatible_versions` requires `resources:read` and exact venue scope. It accepts up to five registry keys and returns each latest registered version with current compatibility. It does not load the entire catalog. Required tools are compared with the intersection of registered server tools and the caller's credential capabilities.
- `NOT_FOUND`, `INVALID_ARTIFACT`, and `MISSING_TOOLS` are explicit read outcomes. A successful historical registration retry may now have missing tools. Neither a registration nor a compatible read authorizes execution.

The administrator routes `registerAgentWorkflowVersion` and `listCompatibleAgentWorkflowVersions` use the same database helpers. Administrator inspection supports up to 50 explicit keys; automatic worker prompt loading and activation are separate lifecycle work.

## Version and evidence rules

Each key starts at version 1. A later version must name the exact preceding scoped version and its rollback content hash. Versions cannot be edited or deleted. Reads verify the stored text and manifest hashes and check that duplicated version, kind, key, and required-tool fields agree with the manifest.

Provenance is returned as `DECLARED_NOT_VERIFIED`: source references and labels such as `HUMAN_AUTHORED` are caller declarations, not verified authorship. The registry has no shared cross-tenant publishing path.

New skill/workflow evaluation evidence must reference `AgentWorkflowVersion:<uuid>`, its exact version and content hash, and currently available tools. Existing historical evidence stays readable. Promotion, canary assignment, revocation, and run-bound selective execution require their own reviewed lifecycle; this registry grants none of them.

## Retained local proof

Migration 220 supplies scoped keys, predecessor foreign keys, and immutable database triggers. Disposable PostgreSQL checks exercise version creation, exact replay/conflict, rollback predecessor, machine identity/worker/credential/lease boundaries, and append-only history. MCP tests cover read-only scope denial, the five-key bound, current credential/tool intersection, and explicit non-activation results. These tests use fixture providers and are not live model quality evidence.
