# Intake extraction to Content task dispatch

Source checkpoint: `0bd2eb32`, inspected 2026-09-10. This records the W01 connection design and its current proof limits; it does not authorize service activation.

Current implementation: `5733e139` connects successful extraction to a durable source dispatch, exact configured SYSTEM task creation, and the existing extraction recovery sweep. Native proof `1195c6b06909` passed 242 migrations / 260 tables / 52 measured sources; PostgreSQL stopped. See `../evidence/source-agent-dispatch-native-2026-09-10.json`. Prior routing/system-constructor proof remains revision-limited to `21c26ea9` / `59ef61baa53a`.

The historical gap and design decisions below explain the implemented connection; do not rebuild it. The outbox UUID is the durable task operation identity, with one outbox per extraction dispatch. Its immutable source locator and retained chosen policy revision/identity provide decision lineage. Completed retries recover the same run even after routing changes. The sweep also discovers completed dispatches whose exact scoped run is still QUEUED, and delays replay publication attempts by 60 seconds using database time.

Subsequent review fixes: `487250c0` redrives retained failed BullMQ jobs and locks/rechecks source authority at execution claim and portable effects. `c3a761de` adds bounded metadata recovery for older completed extractions, before normal source dispatch reconciliation. Native `4a4acfb2ab83` passed 242 migrations / 260 tables / 53 measured sources including concurrent missing-record recovery and explicit post-dispatch capability/autonomy revocations; PG stopped. Historical `d11bf41f1c1b` preserves the preceding authority-only candidate.

Disposable Redis proof `28dafb5a342d` on `1aa9fc93` passed retained failed-job redrive, concurrent reconciliation, single recovery execution and completed replay; Redis stopped. This uses real Redis with worker replacement, not a Redis server crash test. The coherent database suite passed 408 tests; worker tests 8, enqueue tests 43, plus DB/API/workers/jobs typechecks.

Configuration and held-status UI are now implemented below. Remaining scoped work: connected acceptance proof and provider/device gates at their authorized layers. Legacy recovery has concurrent disposable missing-record proof, not a production upgrade rehearsal. The accepted candidate remains a synthetic human review branch rolled back in native proof, not automatic approval.

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

## Client review-stage visibility

`22623cf6` / test refinement `eee99c4c` extend the existing owner-scoped V1 processing read and client list with a separate source review stage. Extraction completion counts remain unchanged. Held, queued, running, awaiting-answer, failed/cancelled, completed preparation and recorded human review are projected without agent IDs, raw errors or source text. Rejected human source review needs attention; an agent awaiting approval is not reported as completed preparation.

Native `b9363520a9a2` passed with 54 measured source hashes, including foreign-owner denial; rendered `fe7ce40f` passed four viewports with keyboard refresh/axe/overflow checks. Both services stopped. See `docs/evidence/source-review-status-2026-09-10.json` for exact proof boundaries and retained failed fixture attempt. Next implementable surface is operator routing configuration/status using the existing admin API, not another source dispatch implementation.

## Operator routing controls

`9cd741df` / `f9a72fd0` add exact tenant/venue candidate pagination and an operator control with default-off routing, explicit specialist selection, revision-based saves and canonical refresh after conflicts or uncertain outcomes. Client-wide CONTENT specialists are eligible only within the exact tenant; no implicit first-candidate selection. Existing tasks retain their original routing. `b0644dcd` / `1990deee` repair the rendered assertion and text contrast.

Native `317665743bf0` and rendered `763b2bc6` passed; all 54 native and three rendered source hashes match the current checkout. Four representative viewports passed keyboard, accessibility and overflow checks and were visually inspected. API routing tests 3/3 and control tests 9/9 passed, with API/dashboard typechecks and changed-source lint. Both services stopped. Exact artifacts and limits are retained in `docs/evidence/intake-source-routing-control-2026-09-10.json`.

Next inspect the seam between the existing connected browser upload/V1/package/QR proof and the automatically dispatched registered-worker question/amendment chain. Reuse both fixtures; do not rebuild these capabilities or infer combined acceptance from separate passes. Broad handoff refresh remains deferred.
