# Guest guide grounding correction — October 10, 2026

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

Tom directly authorized continued repair and release on October 10, 2026: “Ok. Keep doing work
and fixing things up and tell me when we have a new perfect production.” His earlier release
instruction was “I authorize it. Do whatever you need to do.” This is a release-specific,
code-only authorization. It does not resolve the active production database incident or approve
unrelated work. “Perfect” is an acceptance goal, not a claim that a model can never err.

The reviewed corrected application and CI candidate is
`f1b12684b5ce0d96208a6d361ec4d65a32390dce`, tree
`998c3e2fe40f85dfa21c05155f8dfbf8e16bc555`, based on current remote master
`8833ce8599ad0b879d79c0327a84c08e5b8b4fbb`. Production applications were rolled back to
`bfd0a8e427e44dce46219084e8ab5fefc728fdfe` after the prior release failed visitor-answer
acceptance. The correction prevents inferring that an unrecorded amenity is absent, narrows ticket
link intent, and runs the previously skipped no-approval onboarding integration case in CI. The
schema and migration paths have no diff against the current production application revision.
Only this reviewed code candidate plus this documentation and the incident safety-test binding may
enter the final documentation-bearing source, except for a test-only synchronization correction
to `EvaluationRuntimeGateControl.test.tsx` after exact-head CI exposed an existing async assertion
race. The resulting final SHA must be recorded in release evidence and must itself pass every
exact-head gate; application behavior and the reviewed integration-test scope must remain unchanged.

This exception admits **no hosted database migration or data repair**, seed, reset, restore,
deletion, package application, provider or worker flag change, customer send, or credential change.
Preserve existing pending packages and customer data. The production incident remains ACTIVE by
default. A new schema/migration change or new app-code change stops this exception until its scope
and tests are reviewed again. Database backup and migration rehearsal gates are not invoked for
this code-only transition; application rollback uses recorded service deployments, never a
database down migration or Git history rewrite.

Before promotion, require green full CI on the final source, including the isolated PostgreSQL
no-approval onboarding test, exact-head staging CI, healthy staging web/dashboard/workers from one
revision, and trusted exact-revision three-service staging admission. Recheck production's pending
packages read-only. Promote only through the protected staging-to-master pull request and its
production promotion gate. If GitHub creates a merge commit, verify its tree is identical to the
staging-admitted tree, then require master CI and all three production application deployments at
that merge revision. Verify public production health reports that exact revision, healthy database
and queue, then watch health for at least 15 minutes.

Run grounded live visitor acceptance in the approved operator-authored example first, the
previously excluded AI-authored example second, and a wildlife example with the prior lodging
failure last. Tom explicitly requested testing the previously excluded example in this later
investigation; the earlier release record's exclusion remains historical. Include direct known
facts, unknown offerings, explicitly documented negatives and counts, a multi-turn follow-up, and
the ticket-policy citation behavior. Testing creates only normal anonymous guest sessions; it does
not edit venue records. Report each question, answer, evidence, and any failure. If health or answer
acceptance fails, roll back all three application services to the verified previous deployment and
confirm public revision and health. Do not claim production is clean before all gates pass.
