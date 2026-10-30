# Local structured-query attribution protocol

This protocol measures local preparation only. Timing capture is explicitly opt-in,
limited to test/development, and leaves the serving path inactive by default.
No provider calls, deployments, cache implementation or production configuration changes.

## Source and harness identity

Commit instrumentation and this protocol before timing captures. Pin the clean exact
instrumentation commit, reviewed harness bytes, exact source file hashes and all 15
gates at that commit. Record the separately tagged baseline commit and prove ancestry.
The runner checks these identities before and after capture. No failing gate is waived.

Historical planner responses may be used only as fixed synthetic planner inputs.
Verify their original receipt/transport identity before caller timers. Record current
SDK1 request/gateway identities separately. Never claim historical custody covers a
new prompt. No model-decision or answer-quality conclusion follows from synthetic input.

## Workload

Use four fictional fixture families: garden, museum, recreation and zoo.
Each has 100 and 10,000 entities. These counts mean places plus canonical modules:
20+80 and 2,000+8,000. Their directory also contains 60/6,000 knowledge projection rows.
Pin the exact eight generation questions, fixture bytes and explicit fixture clocks.

Use one serialized process, one unreported warmup and five measured repetitions per
family/size. Seed each fixture outside caller timers; reuse that seed for repetitions.
Keep actual isolated Prisma lexical retrieval and selected-body live validation.
Mock only the same source loader and nonretrieval dependencies as the baseline harness.
The mocked loader is a timed fixture clone, not a production database-load measurement.
All provider clients are injected, transport disabled, and runtime values synthetic.

## Stages and boundaries

Retain monotonic caller, first SDK, synthetic response return, second SDK and terminal
markers. The SDK boundary is callback entry, before capture serialization/file output.
Stop SDK2 before answer transport. Expected stop is handled inside the collector's
callback so returned spans survive. Terminal fallback/finalization is outside preparation.

Record these spans with parent IDs, start/end, inclusive duration, self duration and
return/throw outcome: source.load; clone.experiment; clone.page; clone.source; compile;
compile.clone; compile.snapshot; compile.authority.stringify; compile.authority.clone;
names.catalog; planning.prompt; planner.wait; authority; authority.stringify;
authority.clone; evidence.subject; evidence.lookup; prompt.assembly.

Compile inclusive contains its cloning, snapshot setup and owned-authority construction.
Subject/lookup inclusive contains authority work. Self time subtracts the union of direct
child intervals, including overlapping async children. Never sum nested inclusive values.
Stages not exercised by these fixed plans are labeled unexercised, not inferred as cheap.

## Denominators and reporting

Report caller-to-first-SDK preparation and full preparation through second SDK separately.
For full local preparation, report both:

- subtract only the synthetic SDK1 callback interval (including offline capture output),
  retaining actual local gateway/parsing/accounting work;
- subtract the entire planner.wait span as a conservative alternate denominator.

Setup, fixture parsing/adaptation, seeding, historical receipt verification and warmup
are excluded. SDK2 stop handling, finalization and terminal work are excluded as well.
Retain raw spans/markers so exclusive categories and residual work can be checked.
Report per-family/size and by-size medians; do not confuse ratios of medians with median
per-run ratios. Show compile inclusive share against all named preparation denominators.
No provider, first-token, production source-load or end-to-end latency claim is allowed.

Stop before cache work if compile is below about one quarter of preparation at 10,000
entities. Report family variation, alternate denominators and borderline results plainly.
No cache work begins until this attribution decision has been reviewed.
