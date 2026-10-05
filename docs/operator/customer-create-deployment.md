# Customer creation deployment prerequisite

`customers.propose_create` requires `OPERATOR_CUSTOMER_CREATE_ENABLED=true` in the
**dashboard** process environment. Missing, false, or any other value fails closed.
The flag is checked both when proposing (including plan preflight) and when applying.
`operator.propose_plan` has no separate deployment switch. One disabled customer step
rejects a new plan before its transaction records any plan or step proposals.

The October 5 production investigation found no customer-create variable on the
production dashboard and no shared operator variables. Live release was
`88c2d43447c0292869c17dea3f78f64b855ba1db`. The observed `DISABLED` message was
its generic HTTP guidance, masking the customer handler's deployment prerequisite.
Recovery for operation `5d0eeaa6-2159-4486-b405-8c42bc14fc5a` returned
`NOT_FOUND`, `operationRecorded:false`. Filtered runtime logs did not contain request
`a90f8690-829d-4c5a-9738-b77e1038333d`; the trace is reconstructed from the exact
release source, observed response, recovery and provider configuration inventory.

`implemented` means registered handler; `authorized` means capability membership.
Neither guarantees deployment readiness. Context now separately reports each customer
`deploymentPrerequisite` (flag, enabled and recoveryAction). Plans have no independent
customer gate: they inherit each requested step's checks. Customer creation also
requires an all-tenant connection; its approval mode stays `ask`, even under AUTO policy.

## Owner configuration and deployment

1. Review/approve the diagnostic code change through the normal release process.
2. On Railway project `serene-inspiration`, production environment
   `ad140532-61bb-4355-a7e3-ebb2a54d743f`, dashboard service `pathfinder`
   (`3fb757fc-3c77-4768-b3c7-7216e3999f6a`), set only
   `OPERATOR_CUSTOMER_CREATE_ENABLED=true`. Review the complete pending patch before
   applying it. Deploy the approved dashboard revision/configuration normally.
3. This deployment-wide switch admits customer proposals from **all existing permitted
   all-tenant connections**, not just this seven-step operation. OAuth, grant scope,
   always-ask approval, durable create intents, provider reconciliation, receipts and
   plan-derived step operation IDs remain enforced. Creation later calls Clerk to make
   an organization and the canonical local action to make a client and inactive venue.
   It does not require a worker. Proposal preflight does not call Clerk or prove Clerk health.
4. Leave `OPERATOR_CUSTOMER_INVITE_ENABLED`, delivery, billing and publication controls
   unchanged. Invitation remains a separate reviewed operation and switch.
5. After rollout, confirm context reports the prerequisite enabled, then have **dot**
   retry its unchanged seven-step plan with original operation ID
   `5d0eeaa6-2159-4486-b405-8c42bc14fc5a`. Expected next state: `PENDING`, seven
   distinct step proposals and one approval URL. Approval is still required before
   creating records. If an operation is now recorded, recover/replay that same ID.
6. Roll back this workflow by setting the create flag to `false` and deploying that
   configuration; this does not delete existing customers or proposals.

Verification includes real disposable PostgreSQL with all migrations, HTTP/OAuth
customer-plan preflight, named disabled refusals and audit events, seven PENDING steps,
same-ID replay, capability denial and narrow-tenant denial. Existing durability and
customer integration tests cover apply-time gate changes and ambiguous provider outcomes.
No real customer plan is submitted by the repair agent. Hosted staging remains a separate
release gate; a disposable check is not proof of a live staging/production rollout.
