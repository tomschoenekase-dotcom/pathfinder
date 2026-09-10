# Intake extraction to Content task dispatch

Source checkpoint: `0bd2eb32`, inspected 2026-09-10. This is the implementation contract for the next W01 connection, not an implemented or enabled service.

Current implementation: `21c26ea9` adds the scoped disabled-by-default routing policy, admin configuration/read routes, trusted routing admission and SYSTEM source-task constructor; `83fa875b` retains native proof `59ef61baa53a` (241 migrations, 259 tables, 48 measured source hashes). Automatic extraction outbox/dispatch reconciliation remains unimplemented. Continue with decisions 3-6 below; reuse the completed primitives rather than rebuilding them.

## Confirmed gap

`apps/workers/src/processors/intake-v1-file-extraction.ts` completes the extraction dispatch after retaining its receipt. `completeIntakeV1FileExtractionDispatch` recovers the exact receipt and marks the extraction terminal. Neither queues a Content AgentRun. Production `sourceAssignment` reaches `createAgentTaskAction` only through the admin task route. Its actor schema is explicitly HUMAN/PLATFORM_ADMIN, its operation is `operator_task`, and its audit/timeline describe operator intent. A system caller must not fabricate that actor.

`AgentIdentity.identityKey`, type and capabilities do not designate a unique intake processor. There may be several enabled venue/client Content identities. Do not select the first matching row or reinterpret an identity creator as dispatch authorization.

## Implementation decisions

1. Add an explicit durable tenant/venue source-task routing policy with an exact Content identity, revision, enabled=false default, and human configuration attribution. Keep absent, disabled, stale, wrong-scope and revoked identity states distinguishable. A uniqueness constraint on tenant/venue and a composite identity/tenant foreign key are required. Do not overload global PlatformConfig or the IntakeRun creator field.
2. Add a narrow system source-task creation entry point sharing canonical task construction, immutable source assignment, workflow binding and audit. Preserve the existing human API schema. The system entry point derives SYSTEM attribution from the exact durable extraction dispatch and policy; it accepts no arbitrary human actor or general-purpose prompt from transport. Use a versioned bounded source-review prompt. Keep task creation separate from paid/provider execution.
3. Derive a deterministic task operation identity from tenant, venue, source dispatch, receipt, extracted hash and policy revision. Retain the chosen policy revision/identity in task lineage. Retries of the same decision recover one run. Never silently reroute a previously queued run when configuration changes.
4. Persist an outbox/dispatch decision at the successful extraction boundary, then create the task in a separately ordered transaction. Do not call task creation while holding upload/processing locks: source-task construction takes the receipt review lock before task/workflow locks. Explicitly document and test the cross-subsystem lock order. Network/queue calls occur only after commit.
5. Reconcile retained undispatched decisions automatically using the existing worker scheduler pattern; do not rely solely on the original extraction callback. Disabled or ambiguous routing must retain a visible held reason without converting a successful extraction into failure. Cancellation, source review, policy revision and current identity authorization are rechecked before first task creation. Recover an already-created task after a lost response before deciding whether any new work is permitted.
6. Prefer a dedicated small source-agent dispatch record rather than broadening the closed WEBSITE/FILE extraction policy enum. Reuse the current AgentRun execution queue, source assignment reader, questions, amendments and review/candidate path. The dispatch record supplies durable retry/hold lineage; it is not a second agent engine.

## Proof required before connection is claimed

- Native PostgreSQL: completed extraction plus exact enabled policy creates one SYSTEM-attributed source task; duplicate completion/reconciliation and concurrent contenders cannot create two.
- Crash boundaries: extraction commit before enqueue; task commit before dispatch acknowledgement; scheduler restart. Read back the same task and exact source version.
- Missing/disabled/wrong-tenant/multiple candidate identities never cause implicit selection. Policy changes do not relabel prior task ownership. Revoke/cancel/terminal source review deny new dispatch at the effect boundary.
- Registered fresh worker claims the automatically created run, reads assigned source, asks a foundational question, resumes after answer, records amendment, then explicit human review yields the existing candidate. Existing native source proof is reusable only for its retained revision and layers.
- Unit/contract tests for strict policy input, system provenance and operation identity; UI proof only if a configuration/status view changes.

No source review, package approval/application, publication, provider activation, customer contact or deployment authority is added. Original128 requirements,32QA and A/B/C remain intact. The broader Sol handoff packet is intentionally unchanged per Tom's latest instruction.
