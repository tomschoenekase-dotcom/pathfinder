# Visit-aware recommendation candidates

Implementation: `5e317ac7850663ce53414dd013416e614a870e42`.

FM03 connected text/voice slice: apply the shared visit policy after scoped place reads and identity resolution. Overfetch by at most the existing 20 visited IDs, then retain at most eight eligible place facts. Preserve authorized visited labels separately as bounded preferences. Unknown IDs never resolve new records. Ambiguity, explicit revisits, direct detail requests and direct named recommendation opinions preserve factual access. Recommendation-only featured-place handling cannot reintroduce excluded facts.

Both text and voice receive eligible-choice and honest-empty guidance. Cards, PLACE citations and voice place source IDs use the eligible pool. This does not enforce arbitrary provider prose: the negative-provider fixture intentionally names a visited gallery while proving that it receives no eligible card/citation. Do not describe this as end-to-end prevention of repeat recommendations. Knowledge and alerts remain factual context.

Proof: 285 focused tests; full API types and configured lint passed. Fresh native PostgreSQL proof `0c4240d92d96` applied 247 migrations / 264 tables and passed one combined real text/voice test: first eight visited plus ninth unvisited, private/sibling exclusion, all-visited empty text pool, explicit revisit and voice detail. All measured bytes match after commit; owned database stopped. Provider and embedding are deterministic fixture boundaries. Native projection uses the non-native resolved/legacy path, not an active museum package.

See `../evidence/guest-recommendation-candidates-2026-09-10.json` for exact source hashes and failed-attempt identity. Prompt contract advances to v22; historical v21 proof remains historical.

Remaining: live answer usefulness, multilingual intent coverage, reasons and comparisons, current Mini Museum package/model/full September 8 logs, device and human field QA. English query heuristics are conservative and do not establish every recommendation intent. No broad campaign completion, provider, deployment or customer claim. Preserve all original requirements and external reservations; broad continuation packet refresh is deferred per Tom.

## Active native release follow-up

Commit `dce1cdf5a2ab3f8d29275a0137cf198a9325bb10` extends the existing action-backed approved/applied release rehearsal. Fresh proof `b84027aa09a3` passed the selected combined test through active native, dark, authorization, fallback, isolation and kill-switch checks; two other cases were unselected. The recommendation assertion proves exact NATIVE release lineage, no eligible visited PLACE cards/citations/voice sources, current topic-relevant knowledge and alerts retained, and native detail available on explicit follow-up. All measured source bytes match after commit. API types, fixture lint and 12 shared-policy tests passed. The earlier generic-query fixture failure is retained in the new evidence JSON. This adds the active-native fixture layer; it does not replace the separate live/provider/field gates.
