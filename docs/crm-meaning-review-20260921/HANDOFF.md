# Native source-bound claim / meaning review

**Delivered locally and exercised. SEND AUTHORIZED: NO.**

This extends the existing accepted CRM; it is not another validator, review database, sender, campaign, or research import. Native source-bound review works in the actual local UI. One additional broad database fingerprint sweep was blocked before execution and is explicitly excluded from acceptance coverage.

## Source and ownership

Worktree: `C:\Users\tomsc\Downloads\PathFinder-crm-research-20260919`

Branch: `codex/torchiko-crm-research-20260919`

Source implementation commit: **`d67a625b2121144e674a86822c2ff667f80b0664`**.

Reconciled starting HEAD: `77afaa88945e9d886dc8fea1d2095f589b5c4435`, descending from sales `5799a7b76f4de210d755a03acacd3e281f78b6cd` and foundation `aace14ae6ee8bc87b8556dcdfda208004d20c87d`. Nothing was reset to an older hash. Resolve the subsequent evidence-only commit with `git log -1 --format=%H -- docs/crm-meaning-review-20260921/HANDOFF.md`; the vault pointer also records it.

`SOURCE-IDENTITIES.json` contains all 23 changed source/test/helper file identities, Git blob objects, current working-byte SHA-256 values, the accepted component identities, and 234 upstream file hashes. A post-source-commit check confirmed all 12 pinned native runtime files still exactly match the passing native acceptance binding. Upstream Composer, WLT, Research Gate, correspondence, and Approved Language files remained read-only and unchanged.

The existing source-context route was used first: `AwesomeVault\95 AI Staging\Source Context\torchiko\20260921T054943Z-9ce9b854`, core `589e2beccb35965b1dec56e895cceadf6a438c17e6a8c70d3a116714c6366c7f`. Its partial/truncated projection was treated as evidence, not authority. The exact user-specified native source, handoffs, baseline browser receipt and original Composer implementations were subsequently read. Root project `AGENTS.md` was absent; project `CLAUDE.md`, vault `AGENTS.md`, source-context skill and installed frontend/UX standards were read.

## Native implementation

| Existing owner / extension                                       | Responsibility                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/crm-sales/component_bridge.py` + `component_meaning.py` | Invoke the actual original Composer annotation, language and meaning checks; retain conservative claim/WLT holds; no network, upstream writes or sender.             |
| `packages/api/src/prospect-meaning-contract.ts`                  | Strict bounded annotation, reviewer, verdict, language-use, question-answer and exact-revision request contracts. Client-computed approvals/components are rejected. |
| `packages/db/src/helpers/prospect-sales-meaning.ts`              | Exact binding, current-source checks, append-only assessment receipts, idempotent retry and serializable compare-and-swap.                                           |
| `packages/api/src/prospect-sales-meaning-view.ts`                | Read projection of existing native activities: exact claim evidence, current applicability, stale/historical receipts and separate read acknowledgment.              |
| `packages/api/src/prospect-sales-workflow.ts`                    | Native orchestration and current-component revalidation; an older draft cannot inherit a newer preparation's authority.                                              |
| `apps/dashboard/components/admin/ProspectClaimMeaningReview.tsx` | Real claim/source inspection, explicit assessment form, findings/holds and immutable history within the existing review panel.                                       |

No Prisma model, migration, review database, approval table or send path was added. Meaning evidence is appended to the existing trigger-protected `ProspectActivity` ledger using `schema= torchiko.native-sales-review/1` and the distinct scope `CLAIM_MEANING_ASSESSMENT_NOT_APPROVAL`. The existing read-review scope remains `OPERATOR_READ_REVIEW_NOT_COMPOSER_SEMANTIC_CERTIFICATION`.

### What is bound

Each receipt binds the native draft ID/version/content hash, exact subject/body bytes, native recipient or contact-form URL, contact/venue/organization identity, preparation ID and series, source snapshot, preparation component and file hashes, original Composer draft/preparation identities, writer context and research snapshot, WLT packet identity, approved-language snapshot, relevant runtime/library files, and thread/current inbound/provider-snapshot identities. Exact annotations, references, ordered assessments, question-answer mappings, attributed reviewer and recording actor are retained with the receipt.

The existing exact-JSON storage envelope is reused so JSONB normalization does not silently alter Python-origin component evidence. Annotation offsets use Unicode code points, matching the original Composer contract; non-BMP text is covered by integration/UI tests. The native hash is deliberately not confused with the Composer draft-byte hash or WLT body hash.

Saving changed text creates a new immutable revision with no inherited claim review. Changed recipient/form URL, native source/contact snapshot, thread/inbound evidence, selected preparation, or relevant runtime/library identity makes prior applicable review stale. Earlier rows are not rewritten. Unsaved text changes immediately disable both review controls. The UI projects a bounded recent-history window; the underlying ledger is retained.

Concurrent submissions must identify the same current review head. Two actual competing transactions produced one append and one explicit conflict, not silent overwriting. Identical retries reuse the same immutable receipt. Append-only middleware and PostgreSQL triggers independently refused update/delete probes. Trigger probes were restricted to this run's synthetic rows inside rollback-only transactions.

### What a review does not establish

Source facts, relationship facts, task direction, sales hypotheses, nonfactual courtesy and unsupported additions are distinct. Each claimed source is inspectable with its original text, pointer, source identity, hash and limitation. A checked reference is a recorded mapping, not proof of semantic entailment.

The bridge calls the unchanged original functions `validator.check_annotations`, `validator.check_language` and `validator.check_meaning_review`. It also retains the original conservative risk/WLT findings. It does **not** invoke the original upstream filesystem-bundle validator, whose bundle-path lifecycle belongs to its own owner. Native revision, storage, source and concurrency checks supply this lane's lifecycle. No upstream path guard was disabled or relocated.

The UI does not call an AI model automatically. It records explicitly attributed submitted judgments. Initial spans are unreviewed, with no invented supported verdict. Model assessment is neither authenticated human review nor deterministic semantic proof. No Tom approval, reusable-language approval, or send approval is created. The local fixture records a `SYSTEM` actor beginning `synthetic:crm-meaning:` rather than pretending a browser action was human. A local synthetic request asserting `reviewer.kind=human` is denied. The real admin path binds human identity server-side to the authenticated operator, but no real human assessment was fabricated or used for acceptance.

Read acknowledgment and meaning assessment remain independently visible. The unsupported-claim draft can be acknowledged as read while its meaning status stays **BLOCKED**. `ASSESSED_NO_SEND` alone does not record a read acknowledgment. Neither state changes a native draft to approved or gives send authority. Approved Language's actual catalog had **zero approved entries and zero selections** throughout; no sample wording was relabeled as Tom-approved.

## Acceptance evidence

All paths below are relative to `artifacts/crm-meaning-review-20260921-r001/` unless stated otherwise. `ACCEPTANCE-RECEIPT.json` beside this handoff is the compact acceptance index.

| Check                                                          | Result                         | Receipt                                               |
| -------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Actual original Composer/adapter integration                   | **28/28**                      | `python-r002.log`                                     |
| Native lifecycle and source-bound storage tests                | **22/22**                      | `native-unit-r003.json`                               |
| Strict API and existing admin authorization tests              | **23/23**                      | `api-unit-r002.json`                                  |
| Existing/native claim UI tests                                 | **13/13**                      | `ui-unit-r003.json`                                   |
| Retained local database acceptance                             | **47/47**                      | `native-r004.json`                                    |
| Real installed Edge browser journey                            | **70/70**                      | `browser-r003/receipt.json`                           |
| Database, API and dashboard no-emit typechecks                 | **Passed**                     | `typecheck-execution-receipt.json`                    |
| Dashboard typecheck with restored original dirty configuration | **Passed**                     | Same execution receipt, Core completion `34948`       |
| Read-only dependency comparison                                | **234 unchanged**              | `dependencies-before.json`, `dependencies-after.json` |
| Additional broad database fingerprint sweep                    | **Not executed: tool blocked** | `preservation-r001-BLOCKED.json`                      |

The focused suites total **86 passing tests**, independently of the native/browser journey assertions. Actual matched test files are listed in the acceptance index; nonexistent optional correspondence/local-boundary filename targets were not counted as tests or coverage. All groups ran serially with at most two test workers. Typechecks produced no diagnostics; PowerShell did not create empty `Tee-Object` files, so the execution receipt records actual successful command completions rather than presenting nonexistent logs.

### Browser journey actually exercised

The browser navigated the native prospect directory to the existing detail/review panel, used keyboard Tab/Enter to prepare, saved exact draft revisions, inspected factual source text/pointers/hashes, filled explicit category/verdict/reason/attribution fields, recorded findings, and independently marked the exact revision reviewed-no-send.

It included the deliberately unsupported assertion **“Your Moon Gem Gallery exhibit costs $25, and I visited it yesterday.”** Even with a deliberately wrong model `supported` judgment, original Composer checks retained exhibit/personalization, numeric/price and completed-visit holds. Correcting the draft required new review. Changing a reviewed subject disabled actions immediately, then required a fresh saved-revision assessment. The form-route view bound a URL without fabricating an email recipient.

The reply journey mapped new-response spans to the current native inbound point and did not dump the email chain. Changed synthetic inbound evidence made the saved draft and its meaning receipt visibly stale on reload. A genuine `MULTIPLE_UNANSWERED_INBOUND_MESSAGES` hold was not bypassed: to exercise an ordinary reply case, the fixture owner appended explicitly synthetic-only dialogue data with references to all outstanding fixture inbound IDs. Those outbound fixture rows are **not sent messages or human actions**. Earlier fixture messages and review rows were retained and hash-compared. The final changed-inbound case intentionally leaves that reply stale/held again.

Seven screenshots are retained in `browser-r003/`. Desktop width 1440 and narrow widths 375/320 showed no horizontal document overflow. Desktop meaning review, 375px meaning review and 375px stale reply all had zero automated accessibility violations. Keyboard preparation and visible focus were exercised; no uncaught JavaScript/hydration error occurred. Representative desktop, 320px evidence and 375px stale-state images were also visually inspected. See `UX-AUDIT.md` for the limited audit scope.

## Source preservation, environment and cleanup

The exact P03 native source/contact fingerprint remained unchanged across native and real-browser draft/review work. Actual append tests compared pre-existing synthetic message rows and prior review rows byte-for-byte after new inbound evidence. Native zero-state checks confirmed no campaign, send batch/item/outbox, follow-up, human inbound review, enabled provider, approved native draft or real correspondence was created.

The initial read-only 42-table snapshot is retained as `db-before.json`. **Do not claim a final 42-table or 41-table full-row preservation proof:** the subsequent broad readback command was blocked by the tool before execution and was not replayed through another route. Its helper was syntax-checked only. The expected mutable fixture exception is existing synthetic thread latest-message metadata after explicit inbound appends; no blanket unchanged-database claim is made.

The retained container `torchiko-crm-research-db-20260919` at **`127.0.0.1:58617`** was reused without recreation or migration. No importer was run. No Gmail/provider access, research crawl, campaign, deployment, production credentials, local model, extra AI worker, dependency install, worktree creation, Unity activity or production build occurred.

One owned Next **development** preview used the existing launcher and one isolated Edge browser at a time. The browser closed at the end of each run. The exact owned preview PID/start-time/process tree was verified and stopped; port 58618 was released. No other lane's or personal browser's process was targeted. Cleanup evidence: `preview-r001/preview-owner.json` and `preview-stopped.json`. Disk free space was 8.32 GiB initially, at least 8.202 GiB at the final browser checkpoints, and 8.215 GiB after preview cleanup—above the 5 GiB reserve.

Both intentional dirty files remain outside the commits and retain their original bytes:

- `apps/dashboard/next-env.d.ts`: `6902ed943c3fc642ee66cae54f04765d7b3331309d39c79b241bd3578a440ea4`
- `apps/dashboard/tsconfig.json`: `127b6f212c9527cc51931abb193204b1ca4357910029450dc4af04858140a45c`

Next's own temporary change to the generated route-reference line was restored from the pre-preview byte-exact backup after verifying both backup and current-file hashes. No Git reset/clean was used. Pre-existing untracked sales evidence was neither staged as this lane's work nor removed. The normal pre-commit hook ran its scoped Prettier task; no hook or permission bypass was used.

## Retained failures and limits

The accepted earlier **sales** `browser-r003` remains the baseline; its superseded sales `browser-r002` was not reopened. The following are separate **meaning-review** run receipts:

- Native `r001` expected the database error before append-only middleware; native `r002` expected the wrong draft-trigger name. Both protections worked; expectation corrections are covered by native `r004`.
- Meaning browser `r001` exposed a real implicit-select-label issue. Controls now have explicit independent labels, with regression tests and full browser proof.
- Meaning browser `r002` stopped at a legitimate multiple-unanswered-inbound hold. A pending response promise also interrupted the original receipt writer. Its log, screenshots and recovered failure receipt are retained; no missing coverage is invented. The response-wait handling and explicit synthetic dialogue fixture are covered by browser `r003`.
- Synthetic dialogue `r001` referenced only the latest inbound, leaving an older inbound legitimately unanswered. Its failure is retained; `r002` correctly referenced all outstanding synthetic inbounds without changing reducer policy.
- Initial dashboard test-fixture typing and test-file formatting failures were fixed and rerun. The delivery inventory's first attempt expected nonexistent empty typecheck logs; it now uses the actual execution-completion receipt.
- Core session discovery and Desktop observation returned `-32602` (tool not found). Cross-chat registry ownership and Desktop-control proof are not claimed. Exact worktree/process ownership and real browser behavior were checked instead. The final broad database readback block remains a verification limitation.

No human acceptance, semantic certification, reusable-language approval, send authorization or production readiness is inferred from these results. Git warns of possible CRLF on a future checkout; exact working-byte hashes are intentionally conservative, so a changed runtime/library representation requires fresh preparation and assessment.

## Resume without changing ownership

The preview is intentionally off. From this exact worktree, the existing command remains:

```powershell
powershell -NoProfile -File scripts/run-local-crm-research.ps1 -Mode preview -EnableSalesPreparation
```

The local page is `http://127.0.0.1:58618/dev-fixtures/prospect-research`. No credentials or provider setup is needed for the explicitly local synthetic fixture. P03 contains the completed source-bound no-send journey; P02 contains retained reply evidence and the intentional changed-inbound stale state; P06 exposes the form-route binding.

Do not reset fixture history to repeat acceptance. Native acceptance supports `--advance-synthetic-dialogue` only for clearly labeled local synthetic test data; its append limits and existing correspondence guards remain in force. New receipt filenames are required. Do not automatically retry the separately tool-blocked broad preservation command without resolving that authorization boundary.

**SEND AUTHORIZED: NO.**
