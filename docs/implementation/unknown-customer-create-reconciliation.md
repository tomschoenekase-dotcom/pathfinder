# Reconciling an unknown customer-create operation

> **Migration instruction status: INCIDENT STOP — DO NOT EXECUTE EXTERNAL DATABASE COMMANDS.**

Applies to `customers.propose_create` operations whose recorded outcome is `unknown`. First case:
operation `36b36c4b-151d-44d5-a801-cf0d0cd6a29c`.

This runbook is for an authorized platform engineer. It is not executed by the release that adds it.
Do not retry, re-propose or create the customer by hand until step 4 reports a settled state.

## Why this operation looked lost

The operationId is chosen by the caller, not issued by the server. The audited call failed inside
`createProposal` before the proposal row was inserted (or the call failed in a way the server could
not classify), and the HTTP layer labelled every unclassified write failure `TOOL_FAILED`,
`retryable:false`, `outcome:unknown`, telling the caller to look the id up. No row existed, so
`operator.get_operation` correctly answered NOT_FOUND. From this release on:

- a write that fails before its row exists returns `NOT_RECORDED` with `outcome: "none"`,
  `operationRecorded: false` and is safe to resend with the same operationId;
- once a row exists the operation id always resolves, in every state;
- an apply that began and was interrupted is recorded as `FAILED` / `OUTCOME_UNKNOWN`
  (effect `unknown`), never retried, and is settled by `operator.recover_operation`.

NOT_FOUND for `36b36c4b-...` is therefore expected to persist: that operation was never recorded,
so it has no durable effect to reconcile through the operation record. Establish what, if anything,
exists using the read-only checks below, then decide with the owner.

## 1. Read-only checks (change nothing)

Run against production with a read-only database role. Do not call any write tool.

1. Operation record, from the operator connection that sent it:
   `operator.get_operation { "originalOperationId": "36b36c4b-151d-44d5-a801-cf0d0cd6a29c" }`.
   - A found operation: read `status`, `effect`, `failureCode`, `summary`, `nextAction`. Go to step 3
     if `effect` is `unknown` or `partial`.
   - NOT_FOUND with `operationRecorded: false`: continue below.
2. Intent receipt (the fence written before any provider call):

   ```sql
   SELECT status, provider_organization_id, completed_tenant_id, completed_venue_id,
          local_slug, created_at
   FROM client_create_intents
   WHERE request_id = '36b36c4b-151d-44d5-a801-cf0d0cd6a29c';
   ```

   - No row, or `RESERVED`: the provider was never called. The create had no effect.
   - `PROVIDER_STARTED`: the provider call may have happened. Treat as unknown.
   - `PROVIDER_CONFIRMED` or `COMPLETED`: an organization exists; note `provider_organization_id`.

3. Local records for any candidate organization id or the intended slug:
   ```sql
   SELECT id, slug, name, created_at FROM tenants WHERE id = '<organization id>' OR slug = '<slug>';
   SELECT id, slug, is_active FROM venues WHERE tenant_id = '<organization id>';
   ```
4. Audit trail for the operation: `operator_audit_events` rows where `tool = 'customers.propose_create'`
   around the failure time (look at `outcome`, `request_id`). Rows hold redacted arguments only.
5. Identity provider, read-only, in the Clerk dashboard: search organizations by the customer name.
   An organization created by this release carries private metadata
   `pathfinderCreateOperationId = <operationId>`. An organization created before this release has no
   such key; match it on exact name, creator (the approving administrator) and a creation time after
   the intent's `created_at`. Record every candidate id. Do not edit or delete anything.

Decision table:

| Intent / provider evidence                       | Meaning                            | Action                                  |
| ------------------------------------------------ | ---------------------------------- | --------------------------------------- |
| No intent row, no matching organization          | Nothing happened                   | Safe to propose again (new operationId) |
| Intent `PROVIDER_STARTED`, one matching org      | Org exists, local record missing   | Step 3 (reconcile), do not recreate     |
| Intent `PROVIDER_STARTED`, several matching orgs | Ambiguous                          | Stop; escalate to the owner             |
| Tenant and venue exist locally                   | Client was created                 | Reconcile to applied (step 3)           |
| Tenant exists, no venue                          | Client created, venue setup failed | Reconcile reports partial; escalate     |

## 2. Preconditions for any change

- `OPERATOR_CUSTOMER_CREATE_ENABLED` state recorded. Reconciliation does not need it, but no new
  create may be proposed while an unreconciled operation exists for the same customer (the server
  refuses it with `UNRECONCILED_PRIOR_OPERATION`).
- The owner has agreed in writing to the action taken from the decision table.

## 3. Reconcile (only if the operation is recorded as `unknown` or `partial`)

From the operator connection that proposed it:

`operator.recover_operation { "originalOperationId": "<operationId>" }`

This is read-only toward the provider (it searches organizations; it never calls create) and only
writes bookkeeping on this operation and its intent. It moves the operation to exactly one of:

- `APPLIED` (client and draft venue exist; completion recorded, receipt marked `reconciled`);
- `FAILED` / `PARTIALLY_APPLIED` (effect `partial`; `summary` says what exists, for example
  "Identity-provider organization created; local client record and draft venue not set up; no
  invitation sent");
- `FAILED` / `FAILED_NO_EFFECT` (effect `none`; the provider was searched completely and holds
  nothing for this operation, nothing exists locally);
- unchanged `OUTCOME_UNKNOWN` (provider down, search incomplete, or ambiguous). Re-run later; do not
  work around it.

If the operation was never recorded (NOT_FOUND), there is nothing for this tool to reconcile. A
legacy organization found in step 1 that has no operation record is handled by the owner through the
existing platform-admin reconcile flow (`reconcileClientAndVenue` with the original request id),
which verifies the organization and the administrator at the provider before binding it.

## 4. Verify and close

1. `operator.get_operation` again: `effect` must be `applied`, `partial` or `none`, not `unknown`.
2. For `partial`: the organization is bound to the operation's intent. A person finishes local setup
   through the platform-admin flow using the same request id; never create a second organization.
3. For `none`: a new operation may be proposed, with a new operationId.
4. Note the outcome, the evidence queried and the reviewer in the incident record.

## Never

- Never send a new operationId for the same customer while this one is `unknown` or `partial`.
- Never create the organization manually in Clerk, or delete a candidate organization, before the
  intent and local checks above are complete.
- Never run write statements against `client_create_intents` or `operator_proposals` by hand.
