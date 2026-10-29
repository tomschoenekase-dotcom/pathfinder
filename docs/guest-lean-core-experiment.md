# Guest prompt experiments

These are unmeasured, independent lab treatments. Both default off. No deployment or venue-setting change is included.

- `GUEST_CHAT_LEAN_CORE=on` replaces only the static instruction construction with `guest-lean-core-v1`. It applies to any explicitly configured model, allowing the same treatment across model comparisons. It preserves the existing response-depth/DEFAULT/EXPAND/COMPARE instructions verbatim. It fixes the historical opening typo only in this experimental path.
- `GUEST_CHAT_ECONOMY_SHAPE=on` appends the separate `guest-economy-shape-v1` instruction for the configured model and its fallbacks. It asks for 35 to 45 words ordinarily, with room for completeness and safety. It can be compared alone, with lean, or with existing decision-first guidance. Existing decision-first model gates and answer-check precedence are unchanged.

Use identical depth, model, context and answer-shape settings in an isolated lean comparison. Economy shape is a separate writing treatment, not evidence of lean savings. No output token cap changes. Shorter instructions can admit more whole records under unchanged prompt budgets; compare captured source membership or freeze identical evidence for a strict instruction-only pair.

The core is 3,989 characters. Conditional location, tone, language and response-depth instructions remain outside that count. Existing dynamic safeguards and engagement, identity, recommendation, date, action and live-data contracts remain assembled normally. A minimal fictional default request has 8,150 total system characters versus 12,751 for the control. Rich capabilities can increase this. This does not achieve a 3,000-character total instruction budget.

Source escaping, whole-body metrics, dedupe/replacement markers, admission limits, citation intent/selection and stream-safe dash formatting retain their existing owners. No lexical refusal classifier, second formatter, source truncation or venue-specific branch is added. Prompt tests establish construction invariants; they do not prove model security, correctness, writing quality or cost wins.

The production v44 prompt identity and all three existing contract pins stay unchanged: the default representative manifest and a fictional exact-byte capture are identical. The opt-in core has a separate version and pinned SHA-256 in `guest-lean-core.ts`; experimental results must record both that identity and the flags. Do not treat a v44 metadata field alone as identifying an experimental request. Re-pin the production contract when promoting any treatment to the default.

Validation includes fictional boundary, source-escaping, response-depth and conditional-contract fixtures, real-router capture of both flags on Luna and Sol, and existing citation/stream-formatting tests. Paid model evaluation and holdout acceptance remain separate gates.
