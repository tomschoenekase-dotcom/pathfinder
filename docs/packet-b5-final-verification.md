# Packet B.5 integration, staging rollout, and owner-action handoff

Verification date: 2026-08-21

## 1. Canonical integrated commit

The canonical implementation reviewed by this handoff is `1720769b1ebbfc0cd026816e3d57e43440e46a1b`
on `codex/torchiko-packet-b5-staging-20260821`. The branch starts from the verified Company Brain
tip `56e618ef80af9ba717792380c14080e32d0fd8e6` and contains two B.5 implementation commits:

- `56678ce814792ad8a53f573d637d9915d222b507` — Gmail source references and durable summary refresh;
- `1720769b1ebbfc0cd026816e3d57e43440e46a1b` — provider-free CRM summary maintenance.

The documentation commit containing this handoff is intentionally not self-referential; use the
branch tip reported by Git when deploying.

## 2. Company Brain commit discrepancy

Both reported hashes are real and ordered. `57e6f31f281e09cb1a209afe1264c05aeca9a56a` is the final
Company Brain implementation/repair commit. `56e618ef80af9ba717792380c14080e32d0fd8e6` is its direct
descendant and adds `docs/company-brain-final-verification.md`. The latter is therefore the verified
Company Brain branch tip and the correct B.5 base; no missing or divergent implementation exists.

## 3. Branch and lineage map

```text
0fbd054  origin/codex/pathfinder-v2-staging
   |
2306051  CRM staging reconciliation
   |
0723ef0  Packet A completion
   |
57e6f31  Company Brain final implementation
   |
56e618e  Company Brain verification handoff
   |
56678ce  B.5 source-reference + refresh integration
   |
1720769  B.5 provider-free CRM runtime integration
```

`0fbd054` is an ancestor of every later node. There are no remote staging-only commits after the
Company Brain tip, so no merge/cherry-pick conflict exists and unrelated staging work is preserved.

## 4. Integration summary

B.5 reused Packet A and Company Brain without parallel infrastructure. It added only two surgical
repairs exposed by rollout review:

1. `torchiko.account.correspondence` continues returning bounded snippets, but now includes Gmail as
   the canonical authority plus provider account/message identity, RFC message identity, and a safe
   Gmail original-source link when available. Full bodies are not returned by the agent projection.
2. Meaningful meeting changes already marked account summaries `STALE`; B.5 added a five-minute
   BullMQ maintenance scan that invokes the canonical, audited, digest-idempotent refresh action.
   Failed work remains durable as `STALE`. The queue runs in the normal worker and in Packet A's
   provider-free `crm-only` mode, so staging does not need outbound-provider authority.

No schema, migration, alternate scheduler, alternate CRM store, or alternate tool registry was
created.

## 5. Migration result

A fresh exact-name `pgvector/pgvector:pg16` disposable database on loopback was created and checked
before use. The guarded disposable wrapper applied the complete chain from zero:

- migrations discovered/completed: **141 / 141**;
- public tables: **193**;
- current database: `pathfinder_disposable_packet_b5`;
- failed, unfinished, or rolled-back migrations: **0**.

The checked-in staging predeploy gate independently freezes the same 141-file manifest, final
migration `20260821201000_add_meeting_processing_capability`, manifest hash, and 193-table result. B.5
adds no migration.

## 6. Full verification results

Passed:

- focused account correspondence, account summary, scheduler, crm-only, startup-policy, and
  provider-disabled tests;
- `pnpm test` across the monorepo and script gate;
- `pnpm build` for all 14 workspaces, including the Company Brain admin route and MCP route;
- provider-free Company Brain friend-takeover/Obsidian-loss shakedown on PostgreSQL;
- realistic-scale Company Brain retrieval proof on PostgreSQL;
- `pnpm verify:ai-boundary` (1 documented temporary worker exception remains from the baseline);
- `pnpm verify:ai-budget` (18 provider gateway sites budgeted);
- `pnpm verify:raw-sql` (97 classified operations);
- tenant bypass registry (280 calls in 91 approved production files);
- generated tenant procedure coverage (103 procedures);
- Prisma scope registry (192 models: 130 tenanted, 45 platform, 17 shared);
- client-bundle secret scan (15 canaries across 463 browser-deliverable files);
- staging config verification (3 services);
- Company Brain diagnostics (9 required tools, 5 scenarios);
- tool coverage (77/77 mounted routers classified).

The first build command exceeded its two-minute shell window without a compiler error. The repeated
build completed successfully in 112 seconds. Client-bundle verification then forced a clean uncached
build and also passed.

## 7. Staging deployment result

The feature branch is ready for the supported GitHub pull-request path, but this execution
environment has neither the GitHub CLI nor Railway CLI and is not authorized to invent/login to an
owner account. Therefore it cannot merge the PR, set the one-run Railway variables, or inspect
Railway deployment records.

Read-only live evidence from 2026-08-21:

- Railway fallback health returned HTTP 200 with `db=up`, `queue=up`, `environment=staging`, and the
  documented staging database/Redis/storage resource IDs;
- that response reported deployment revision `unknown`, so exact-SHA admission correctly cannot
  certify the live release;
- `https://app.staging.torchiko.com` redirected to the sign-in page;
- the canonical marketing site intentionally did not expose the product `/api/health` route.

No staging migration or deployment is claimed. Production was not contacted or changed.

## 8. Staging UI verification

The production build proves these routes compile: Company Brain, CRM prospects/account surfaces,
AI operations, integrations, external credentials, Gmail OAuth, and MCP. The public staging
dashboard sign-in boundary is live. Authenticated deployed UI verification is pending the exact-SHA
deployment and an owner-controlled platform-admin session; no browser profile or personal session
was accessed.

Post-deploy smoke:

1. Open `https://app.staging.torchiko.com/admin/company-brain`; verify browse, type/status filters,
   decisions, priorities, candidates, provenance, and supersession.
2. Open a synthetic mature organization under `/admin/prospects/<organization-id>`; verify summary,
   contacts, venues, recent timeline, open loops, meetings, and bounded correspondence snippets.
3. Open `/admin/operations`; verify worker heartbeat, runs, questions, approvals, failures, costs,
   and secret-free integration health use real records.
4. Open `/admin/clients/<tenant-id>/credentials`; verify the exact-venue MCP credential lifecycle is
   present but do not issue a production credential.

## 9. MCP and worker verification

Provider-free tests prove JSON-RPC initialize, discovery, schemas/metadata, structured errors,
credential scope, tenant isolation, machine attribution, approval consumption, worker registration,
heartbeat/offline behavior, lease recovery, replacement-worker continuation, and the friend-takeover
scenario. The route is `/api/mcp/<tenant-id>/<venue-id>` and remains controlled by verified
credentials and `AGENT_BRIDGE_HTTP_ENABLED`.

Live staging cannot yet be certified because the deployed SHA is unknown and no staging-only MCP
secret was issued. A no-secret probe was redirected to sign-in; this is not an authenticated MCP
success. Production ingress remains dark.

After the exact release is admitted, a platform admin may issue one synthetic exact-venue MCP
credential at `/admin/clients/<tenant-id>/credentials`, copy the secret once, activate that exact
credential, set `AGENT_BRIDGE_HTTP_ENABLED=true` only in staging, run initialize/tools-list and the
friend-takeover smoke, then return the gate to `false` and revoke the credential.

## 10. Google Workspace exact owner setup

Only Gmail is implemented. Calendar, Meet acquisition, and Drive access must not be configured yet.

### Staging Gmail project and OAuth

1. In Google Cloud Console, create/select a dedicated **staging** project (recommended name
   `torchiko-staging-integrations`). Do not reuse production credentials.
2. APIs & Services → Library: enable **Gmail API** and **Cloud Pub/Sub API**.
3. Google Auth Platform → Branding/Audience/Data Access:
   - app name: `Torchiko Staging`;
   - use **Internal** only if the mailbox and all operators are in the owning Workspace domain;
     otherwise use **External / Testing** and add only the staging mailbox/operator as test users;
   - add exactly `https://www.googleapis.com/auth/gmail.modify` and
     `https://www.googleapis.com/auth/gmail.send`, matching `gmail-oauth.ts`;
   - testing grants can expire after seven days, so do not mistake expiry for sync corruption.
4. Google Auth Platform → Clients → Create client → **Web application**. Add this exact authorized
   redirect URI:
   `https://app.staging.torchiko.com/api/integrations/gmail/oauth/callback`.
5. Put the client ID in Railway dashboard and worker service variable
   `GOOGLE_OAUTH_CLIENT_ID` (identifier, not secret). Put the client secret in
   `GOOGLE_OAUTH_CLIENT_SECRET` (secret). Set `GMAIL_OAUTH_REDIRECT_URI` to the exact URI above.
6. Generate a separate staging 32-byte random key, base64 encoded, and place it only in Railway as
   `INTEGRATION_ENCRYPTION_KEY` for dashboard and workers. Rotating it requires reconnecting Gmail;
   never overwrite it while encrypted refresh credentials remain active.

### Gmail watch and authenticated Pub/Sub push

1. Pub/Sub → Topics → Create topic, suggested ID `torchiko-gmail-staging`. Set worker variable
   `GMAIL_PUBSUB_TOPIC=projects/<STAGING_PROJECT_ID>/topics/torchiko-gmail-staging`.
2. On that topic grant **Pub/Sub Publisher** to
   `gmail-api-push@system.gserviceaccount.com`; Gmail cannot publish watch notifications without it.
3. IAM & Admin → Service Accounts → Create `torchiko-gmail-push-staging`. No mailbox/domain-wide
   delegation is needed.
4. Pub/Sub → Subscriptions → Create subscription:
   - topic: the topic above;
   - delivery: **Push**;
   - endpoint:
     `https://app.staging.torchiko.com/api/integrations/gmail/pubsub`;
   - **Enable authentication** with `torchiko-gmail-push-staging`;
   - audience: the exact endpoint URL above;
   - leave payload unwrapping **off**, because Torchiko validates the Pub/Sub envelope.
5. In IAM, grant the Google-managed Pub/Sub service agent
   `service-<PROJECT_NUMBER>@gcp-sa-pubsub.iam.gserviceaccount.com` the **Service Account Token
   Creator** role on the push service account. The human creating the subscription also needs
   Service Account User/`iam.serviceAccounts.actAs` on it.
6. Set dashboard variables:
   - `GMAIL_PUBSUB_PUSH_AUDIENCE=<exact endpoint URL>` (identifier);
   - `GMAIL_PUBSUB_PUSH_SERVICE_ACCOUNT=<push service account email>` (identifier).
7. Keep `PROSPECT_OUTREACH_DELIVERY_ENABLED=false`. For the first source-sync canary use
   provider-free CRM mode or an explicitly reviewed Gmail worker deployment; never enable cold
   outreach as a side effect.
8. Sign in as a Torchiko platform admin and visit
   `/api/integrations/gmail/oauth/start`. Consent with the staging mailbox. The callback stores the
   refresh token encrypted and queues watch renewal plus bounded reconciliation.
9. When worker/provider admission is deliberately enabled, set
   `GMAIL_WATCH_RENEWAL_ENABLED=true` and `GMAIL_RECONCILIATION_ENABLED=true`; verify connected
   status, watch expiration, last successful sync, a matched synthetic thread, provider IDs, and an
   authenticated Pub/Sub receipt. Disable both flags and stop the watch before rollback.

Official references: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions),
and [OAuth consent/test users](https://support.google.com/cloud/answer/13461325).

### Not required now

- Do not enable Calendar API, Meet REST API, or Drive API.
- Do not add Calendar, Meet, or Drive OAuth scopes.
- Do not configure domain-wide delegation.
- `GOOGLE_CLOUD_PROJECT_ID` is currently declared but not consumed by runtime code; it may be kept
  as a safe operator identifier but is not an admission requirement.

## 11. Source retention behavior and gaps

Gmail remains the original authority. Existing sync currently persists normalized `textBody` and
`htmlBody` in `ProspectEmailMessage`; B.5 did not destroy or rewrite those records. Agent account
correspondence returns only a 320-character plain-text snippet, attachment presence, provider and RFC
IDs, canonical authority, and a Gmail source link. A future retention migration may expire body
copies after policy/operational review, but it must preserve audit/source identity and must not be
invented during this rollout.

Attachment sync retains metadata only (`METADATA_ONLY`) and does not download attachment bytes.
Meeting records retain structured summaries/extractions and `sourceArtifactRef`; transcripts may be
durably retained in external Drive/object storage and referenced by Torchiko. Recordings are not
ingested by default. Calendar/Meet/Drive synchronization is not implemented, despite registry-only
feature flags, so those flags stay false and no owner setup is requested.

## 12. Provider evaluation status

Provider-free retrieval and scale evaluations passed. The provider-backed evaluator was not
dispatched: no explicit hard evaluation budget ceiling and no safely available staging provider
credential were established for this run. The owner must create/approve a finite staging evaluation
budget through the existing AI cost-budget admin surface, confirm the economy route, and provide a
staging-only provider credential through the existing secret store. Codex can then run the canonical
suite and report provider, model, case count, measured usage/cost, grounding, and failures.

## 13. Runner and scheduled refresh

The summary scheduler is durable and provider-free: every five minutes it scans at most 50 distinct
tenant/organization summaries marked `STALE`, refreshes through the canonical audited action, and
supersedes stale/current versions. A failed refresh leaves durable stale state; BullMQ retries and a
later scan recover it. Input digests make repeated work idempotent.

Safe staging configuration:

```text
OUTBOUND_PROVIDER_WORKERS_ENABLED=false
CRM_BACKGROUND_WORKERS_ENABLED=true
WORKER_SCHEDULERS_ENABLED=false
EMBEDDING_DISPATCH_ENABLED=false
GENERATION_DISPATCH_ENABLED=false
GENERATION_RECOVERY_ENABLED=false
EVALUATION_RUNNER_ENABLED=false
AGENT_RUNNER_ENABLED=false
AGENT_BRIDGE_HTTP_ENABLED=false
```

This selects Packet A's database-backed `crm-only` runtime and starts only CRM import and account
summary queues. It needs staging `REDIS_URL`, `DATABASE_URL`, and `DIRECT_DATABASE_URL`, not AI or
email-provider credentials. The state survives Tom's PC and any individual worker process.

## 14. Production rollout plan

Production remains unauthorized. When separately approved:

1. Require the exact B.5 staging branch tip to pass CI, exact-SHA health admission, authenticated UI,
   MCP, crm-only refresh, and source-sync canaries.
2. Snapshot production and record resource identities; lift the database incident stop explicitly.
3. Open the supported PR from `codex/pathfinder-v2-staging` to `master`; reject any other source.
4. Run the reviewed migration preflight. B.5 has no new migration, but production must already have
   the Company Brain chain before the application starts.
5. Roll out web/dashboard first with bridge, agent runner, provider workers, evaluations, outreach,
   billing effects, publication, and deployment gates false.
6. Roll out `crm-only` workers with the exact production database/Redis identities and verify stale
   summary refresh on one controlled account.
7. Configure production Google in a separate project/credentials only after the staging canary.
8. Enable one external integration at a time, with monitoring and rollback evidence.

## 15. Rollback plan

- Application: redeploy the last admitted SHA; prefer roll-forward if new Company Brain rows exist.
- Database: migrations are additive; do not drop Company Brain, audit, credential, meeting, or
  approval tables as an automatic rollback. Stop new writers and repair forward.
- Summary worker: set `CRM_BACKGROUND_WORKERS_ENABLED=false` and restart; durable `STALE` rows remain
  recoverable. Do not delete queues or summaries.
- MCP/bridge: set `AGENT_BRIDGE_HTTP_ENABLED=false`, then revoke the exact staging credential.
- Gmail: set both Gmail scheduling flags false, stop/drain the Gmail worker, call Gmail watch stop or
  let the watch expire, delete/disable the Pub/Sub subscription, and revoke the Google grant. Retain
  provider IDs/audit evidence; do not mass-delete correspondence.
- Provider evaluation: disable the evaluation runner and tenant feature gate; preserve usage/cost
  evidence.

## 16. OWNER ACTIONS

1. **GitHub / staging PR** — Push is prepared from
   `codex/torchiko-packet-b5-staging-20260821`. Open a PR into
   `codex/pathfinder-v2-staging`, require CI, review these two implementation commits plus this
   handoff, and merge. Validation: remote staging tip equals the PR merge SHA.
2. **Railway / exact release identity** — In project `serene-inspiration`, environment ID
   `a7a394fc-aa4e-4a45-bd3c-904419a67818`, ensure web/dashboard/workers deploy the same merge SHA.
   Railway must provide `RAILWAY_GIT_COMMIT_SHA`; the current `unknown` health revision is not
   acceptable. Validation: `verify:staging-health` passes with the exact SHA and documented resource
   IDs.
3. **Railway / one-run staging migration** — Before the web predeploy, set the existing fail-closed
   variables, including `PATHFINDER_RELEASE_SHA=<merge SHA>`,
   `PATHFINDER_STAGING_MIGRATION_APPROVAL=torchiko-staging-lineage-to-141-20260821`, synthetic-only
   policy, approved resource/host/database confirmations, explicit opt-in, and ceiling no greater
   than the already-approved USD 10 staging ceiling. Remove the opt-in after success. Validation:
   141/141 twice, 193 tables, no row-count changes to pre-existing tables.
4. **Railway / provider-free summary runtime** — Apply the exact values in section 13 to the staging
   worker and restart after draining older replicas. Validation: startup reports `crm-only`; only
   CRM import and account-summary queues appear; one synthetic stale summary becomes current.
5. **Google Cloud / staging Gmail** — Complete section 10. Secrets are the OAuth client secret,
   encrypted refresh credential, and integration encryption key; project/topic/audience/service
   account/client IDs are identifiers. Validation: OAuth connects, watch expiration is populated,
   authenticated push returns 204, bounded sync associates a synthetic thread, and original-source
   retrieval works.
6. **AI budget** — In the existing Torchiko AI cost-budget admin surface, create and approve an
   explicit finite staging evaluation/test ceiling and confirm the economy-tier route. Do not place
   a dollar value in source control. Validation: admission shows remaining budget before dispatch
   and usage/cost afterward.
7. **Staging MCP canary** — After exact-SHA deployment, issue one exact-venue synthetic MCP
   credential in `/admin/clients/<tenant-id>/credentials`, enable bridge HTTP only for the bounded
   canary, run the friend-takeover scenario, then disable/revoke. The secret is one-time and must be
   stored only in the worker secret environment. Validation: audited machine actor/run/worker IDs,
   exact capability enforcement, lease recovery, no Obsidian dependency.
8. **Production approval** — No production PR, migration, credential, DNS, worker, or provider action
   is authorized by B.5. A separate explicit approval must name the exact admitted staging SHA and
   confirm the incident stop is lifted.

## 17. Launch-readiness checklist changes

No distinct living launch-readiness workbook/checklist was found by bounded vault/repository search,
so no unknown artifact was edited. Objective status to copy into the owner-maintained checklist:

| Item                                        | Evidence level               | Status                              |
| ------------------------------------------- | ---------------------------- | ----------------------------------- |
| Packet A + Company Brain lineage reconciled | Git + local proof            | Green                               |
| Fresh 141-migration / 193-table database    | Disposable DB                | Green                               |
| Full tests/build/security                   | Local CI-equivalent          | Green                               |
| Friend takeover / Obsidian loss / scale     | Disposable DB                | Green                               |
| Gmail source-reference projection           | Implemented + tested         | Green                               |
| Provider-free stale-summary runner          | Implemented + tested         | Green                               |
| Exact-SHA staging deployment                | Live endpoint says `unknown` | Blocked on owner PR/Railway         |
| Authenticated staging UI                    | Build only                   | Blocked on exact deployment/session |
| Authenticated staging MCP worker            | Provider-free DB proof only  | Blocked on owner credential/gate    |
| Gmail live provider                         | Mocked/provider-free only    | Blocked on Google owner setup       |
| Calendar/Meet/Drive sync                    | Not implemented              | Red; future packet                  |
| Provider-backed retrieval evaluation        | Provider-free green          | Blocked on budget/credential        |
| Production                                  | Untouched                    | Deliberately blocked                |

## 18. Intentionally dark or unconfigured

- production deployment, migration, DNS, credentials, workers, and provider ingress;
- autonomous prospect outreach and all cold-email delivery;
- Stripe live mode, checkout effects, reconciliation, and billing mutations;
- AgentRun provider execution and evaluation runner;
- MCP/agent bridge HTTP outside a bounded staging canary;
- publication, deployment application, offboarding finalization, and destructive actions;
- Calendar, Meet acquisition, Drive API, domain-wide delegation, recording ingestion, and blanket
  attachment retention;
- provider-backed retrieval calls until the owner records a hard ceiling and credential.

## Final answer to the architectural test

For the implemented and database-backed scenarios, **yes**: Torchiko's CRM, Company Brain, decisions,
meetings, approvals, machine actors, jobs, leases, worker registry, audit history, and retrieval
interfaces operate without Obsidian and survive the primary worker going offline. Live staging is
not yet allowed to inherit that claim until the owner completes the exact-SHA deployment and bounded
credential/provider canaries above.
